import * as historyApiFallback from 'connect-history-api-fallback';
import { SHA256 } from "crypto-js";
import * as express from "express";
import { Express, NextFunction, Request, Response } from "express";
import * as fs from "fs";
import * as http from "http";
import APIController from '../controllers/APIController';
import DiscordController from '../controllers/DiscordController';
import Config from '../utils/Config';
import Logger, { LogStyle } from '../utils/Logger';
import TwitchUtils from '../utils/TwitchUtils';
import UserData from '../utils/UserData';
import Utils from "../utils/Utils";
import * as rateLimit from "express-rate-limit";
import * as speedLimit from "express-slow-down";
import EventSubController from '../controllers/EventSubController';
import RaiderEvent from '../utils/RaiderEvent';

export default class HTTPServer {

	private app:Express;

	constructor(public port:number) {
		this.app = <Express>express();
		let server = http.createServer(<any>this.app);
		server.listen(Config.SERVER_PORT, '0.0.0.0', null, ()=> {
			Logger.success("Server ready on port " + Config.SERVER_PORT);
		});

		this.doPrepareApp();
	}

	protected initError(error: any): void {
		Logger.error("Error happened !");
		console.log(LogStyle.FgRed+error+LogStyle.Reset);
	}

	protected async doPrepareApp(): Promise<void> {
		//Check if twitch keys are ok
		try {
			await TwitchUtils.getClientCredentialToken();
		}catch(error) {
			//Invalid token
			Logger.error("Invalid twitch tokens. Please check the client_id and secret_id values in the file data/credentials.json")
			console.log(error);
		}

		//Redirect to homepage invalid requests
		this.app.use(historyApiFallback({
			index:"/index.html",
			// verbose:true,
			
			rewrites: [
				{
					//Avoiding rewrites for API calls and socket
					from: /.*\/(api|sock)\/?.*$/,
					to: function(context) {
						return context.parsedUrl.pathname;
					}
				},
			],
		}));

		//CORS security
		this.app.all("/*", (req:Request, res:Response, next:NextFunction) => {
			// Set CORS headers
			res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,PATCH,DELETE,OPTIONS');
			res.header('Access-Control-Allow-Headers', 'Content-type,Accept,X-Access-Token,X-Key,X-AUTH-TOKEN');
			
			//Allow access to private API only if coming from authorized domain
			if(req.url.indexOf("/api/private") > -1) {
				let profile = Utils.getProfile(req);
				if(profile) {
					//If a profile is found, that's because domain origin is valid, allow the request
					res.header('Access-Control-Allow-Origin', "*");
				}
			}else{
				res.header("Access-Control-Allow-Origin", "*");
			}
			if (req.method == 'OPTIONS') {
				res.status(200).end();
				return;
			}
			
			next();
		});
		
		this.initAntiSpam();

		//SERVE PUBLIC FILES
		this.app.use("/", express.static(Config.PUBLIC_PATH));

		this.app.use(express.json());

		/**
		 * Auth middleware to protect POST and DELETE endpoints via SHA256 hash
		 */
		this.app.all("/api/*", async (request:Request, response:Response, next:NextFunction) => {
			if(!TwitchUtils.ready) {
				if(!Config.TWITCHAPP_CLIENT_ID || !Config.TWITCHAPP_SECRET_ID) {
					response.status(401).send(JSON.stringify({success:false, error_code:"MISSING_TWITCH_KEYS", error:"missing twitch API keys"}));
				}else{
					response.status(401).send(JSON.stringify({success:false, error_code:"INVALID_TWITCH_KEYS", error:"invalid twitch API keys"}));
				}
			}else{
				let isTwitchMessage = request.body?.subscription != undefined || request.headers["twitch-eventsub-message-id"] != undefined;
				if((request.method == "POST" || request.method == "DELETE")
				&& !isTwitchMessage) {
					let login = <string>request.query.login;
					let key = request.headers.authorization;
					let hash = SHA256(login + Config.PRIVATE_API_KEY).toString();
					let access_token = <string>request.body.access_token;

					//If using API externally
					if(!access_token) {
						//Check if the given authorization header hash is valid
						if(key != hash) {
							Logger.error(`Invalid authorization key`);
							response.status(401).send(JSON.stringify({success:false, error:"invalid authorization key", error_code:"INVALID_KEY"}));
							return;
						}
					}else{
						//If using API internally via twitch access token
						let result = await TwitchUtils.validateToken(access_token);
						if(result === false) {
							Logger.error(`Invalid twitch access token`);
							response.status(401).send(JSON.stringify({success:false, error:"invalid twitch access token", error_code:"INVALID_TWITCH_ACCESS_TOKEN"}));
							return;
						}else{
							//Populate login on request
							login = result.login;
							request.body.login = result.login;
							request.query.login = result.login;
						}
					}

					//Check if user is valid via twitch API
					let result = await TwitchUtils.loadChannelsInfo([login]);
					if(result.status != 200) {
						let txt = await result.text();
						response.status(result.status).send(txt);
					}else{
						let json = await result.json();
						if(!json || json.data.length == 0) {
							response.status(404).send(JSON.stringify({success:false, error:"user not found", error_code:"USER_NOT_FOUND"}));
							return;
						}else{
							//Inject user login to headers
							request.headers["uid"] = json.data[0].id;
						}
					}
				}
				next();
			}
		});

		this.createEndpoints();
		
		this.app.use((error : any, request : Request, response : Response, next : NextFunction) => {
			this.errorHandler(error , request, response, next)
		});
		
		let fallback = async (req, res) => {
			console.log("NOT FOUND : ",req.url);
			res.status(404).send(JSON.stringify({success:false, code:"ENDPOINT_NOT_FOUND", message:"Requested endpoint does not exists"}));
		};
		//Fallback endpoints
		this.app.all("*", fallback);
	}

	protected errorHandler(error: any, req: Request, res: Response, next: NextFunction): any {
		Logger.error("Express error");
		Logger.simpleLog(error);
		res.status(404).send(JSON.stringify({success:false, code:"EXPRESS_ERROR", message:"An error has occured while processing the request"}));
		next();
	}

	/**
	 * Creates API endpoints
	 */
	private async createEndpoints():Promise<void> {
		this.migrateFileStructures();
		this.migrateUserNamesToIDs();
		Logger.info("Create endpoints");
		let api = new APIController();
		api.create(this.app);
		let discord = new DiscordController();
		discord.create(this.app);
		
		let eventSub = new EventSubController();
		await eventSub.create(this.app);

		discord.addEventListener(RaiderEvent.SUB_TO_LIVE_EVENT, (event:RaiderEvent) => {
			eventSub.subToUser(event.profile, event.channelId);
		});
		
		eventSub.addEventListener(RaiderEvent.DISCORD_ALERT_LIVE, (event:RaiderEvent) => {
			discord.alertLiveChannel(event.profile, event.channelId);
		});
		
		api.addEventListener(RaiderEvent.USER_ADDED, (event:RaiderEvent) => { eventSub.subToUser(event.profile, event.channelId); });
		api.addEventListener(RaiderEvent.USER_REMOVED, (event:RaiderEvent) => { eventSub.unsubUser(event.profile, event.channelId); });
		
		discord.addEventListener(RaiderEvent.USER_ADDED, (event:RaiderEvent) => { eventSub.subToUser(event.profile, event.channelId); });
		discord.addEventListener(RaiderEvent.USER_REMOVED, (event:RaiderEvent) => { eventSub.unsubUser(event.profile, event.channelId); });

		discord.onEventsubReady();

	}

	/**
	 * Migrate user's data.
	 * Before we had one file for user names and one for descriptions, which is quite dumb.
	 * This migration merges both files into one, adding possibility to have as many props
	 * as we want for every user.
	 */
	private async migrateFileStructures():Promise<void> {
		let root = Config.DATA_FOLDER;
		let files = fs.readdirSync( root );
		let hasMigrated = false;
		for(let i = 0; i < files.length; i++) {
			let file = files[i];
			if(file.indexOf("userDescriptions") === 0) {
				Logger.info("Migrate profile", file.replace(/userDescriptions_(.*)\.json/gi, "$1"));
				let usersPath		= root + file.replace(/userDescriptions/gi, "userList");
				let descriptionPath	= root + file;
				let users			= JSON.parse(fs.readFileSync(usersPath, "utf8"));
				let descriptions	= JSON.parse(fs.readFileSync(descriptionPath, "utf8"));
				let newUsers		= [];
				for(let i = 0; i < users.length; i++) {
					let newUser:UserData = <any>{};
					newUser.name = users[i];
					let description = descriptions[ users[i] ];
					if(description) {
						newUser.description = description;
					}
					newUser.created_at = Date.now() - 32*24*60*60*1000;//set it 32 days ago to avoid "new" marker
					newUsers.push(newUser);
				}
				fs.writeFileSync(usersPath, JSON.stringify(newUsers));
				fs.unlinkSync(descriptionPath);
				hasMigrated = true;
			}
		}
		if(hasMigrated) {
			Logger.success("Migration complete");
		}
	}

	/**
	 * Injects twitch user IDs to users list
	 */
	private async migrateUserNamesToIDs():Promise<void> {
		let root = Config.DATA_FOLDER;
		let files = fs.readdirSync( root );
		for (let i = 0; i < files.length; i++) {
			//Only parse user list files
			if(!/userList(_.*?)?\.json/gi.test(files[i])) continue;
			let users = JSON.parse(fs.readFileSync(root + files[i], "utf8"));
			if(users.length == 0) continue;
			//Check if file is already migrated
			if(users[0].id != undefined) continue;

			let twitchUsersReq = await TwitchUtils.loadChannelsInfo(users.map(u => u.name));
			let twitchUsers = (await twitchUsersReq.json()).data;
			twitchUsers.forEach(u => {
				let userLoc = users.find(user => user.name.toLowerCase() == u.login.toLowerCase());
				userLoc.id = u.id;
			});
			fs.writeFileSync(root + files[i], JSON.stringify(users));
		}
	}

	/**
	 * Init rate and speed limiter to reduce spam possibilities
	 */
	private initAntiSpam():void {
		this.app.set('trust proxy', 1);
		this.app.enable('trust proxy');

		const speedLimiter = speedLimit({
			windowMs: 1 * 1000, // time frame647389082
			delayAfter: 5, //max requests per windowMs time frame
			delayMs:500,
			skip:(req:Request, res:Response)=> {
				let isTwitchMessage = req.body?.subscription != undefined || req.headers["twitch-eventsub-message-id"] != undefined;
				return req.method == "OPTIONS" || req.ip == "127.0.0.1" || isTwitchMessage;//No restrictions when testing locally
			},
			keyGenerator: (req:Request, res:Response)=> { return Utils.getIpFromRequest(req); },
			onLimitReached:(req:speedLimit.RequestWithSlowDown, res:Response, options:any)=> {
				Logger.info("Speed limit request ", req.url);
			}
		});

		const rateLimiter = rateLimit({
			windowMs: 1 * 60 * 1000, // time frame
			max: 60, //max requests per windowMs time frame
			skip:(req:Request, res:Response)=> {
				let isTwitchMessage = req.body?.subscription != undefined || req.headers["twitch-eventsub-message-id"] != undefined;
				return req.method == "OPTIONS" || req.ip == "127.0.0.1" || isTwitchMessage;//No restrictions when testing locally
			},
			keyGenerator: (req:Request, res:Response)=> { return Utils.getIpFromRequest(req); },
			handler:(req:Request, res:Response, next:NextFunction)=> {
				let status = (<any>req).rateLimit;
				Logger.info("Rate limit reached ! ", status.current+"/"+status.limit)
				let duration = (<Date>status.resetTime).getTime() - new Date().getTime();
				res.status(429).send(JSON.stringify({success:false, error:"TOO_MANY_REQUESTS", retryAfter:duration}));
			},
		});
		
		this.app.use("/api/", rateLimiter);
		this.app.use("/api/", speedLimiter);
	}
}