
import LinkService, { BaseError, CacheInterface, CacheOptions, CacheResult, type ResolveResult, type ServiceConfig } from '@ffz/link-service';
import isbot from 'isbot';

import { responseError, responseJSON, responseRedirect, writeAnalytics } from './utilities';
import { GLOBAL_HEADERS } from './constants';

type Environment = {
	BLUESKY_IDENTIFIER?: string;
	BLUESKY_PASSWORD?: string;
	BLUESKY_SERVICE?: string;
	IMGUR_KEY?: string;
	TWITCH_ID?: string;
	TWITCH_SECRET?: string;
	YOUTUBE_KEY?: string;
	PROXY_HOST?: string;
	PROXY_KEY?: string;
	SB_SERVER?: string;

	ANALYTICS?: AnalyticsEngineDataset;
	SESSION?: KVNamespace;
	CACHE_DB?: D1Database;
}


function buildConfig(env: Environment): ServiceConfig {
	let cache: CacheInterface | undefined;

	if ( env.CACHE_DB ) {
		const CACHE_DB = env.CACHE_DB;
		cache = {
			async get(key: string, options?: CacheOptions): Promise<CacheResult> {
				let result;
				try {
					result = await CACHE_DB.prepare(
							'SELECT * FROM cache_entry WHERE key = ?'
						).bind(key).first();
				} catch(err) {
					console.log('D1 error', err);
					result = null;
				}

				if ( result?.key === key && result.value ) {
					const ttl = options?.ttl ?? (result.ttl as number) ?? 3600,
						expires = (result.created as number) + (ttl * 1000);

					if ( expires > Date.now() ) {
						try {
							return {
								hit: true,
								value: JSON.parse(result.value as string)
							}
						} catch(err) {
							/* no-op */
						}
					}
				}

				return {
					hit: false,
					value: null
				}
			},

			async set(key: string, value: any, options?: CacheOptions): Promise<void> {
				const ttl = options?.ttl ?? 3600,
					created = Date.now();
	
				try {
					await CACHE_DB.prepare(
						'INSERT INTO cache_entry(key,value,ttl,created) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ttl=excluded.ttl, created=excluded.created;'
					).bind(key, JSON.stringify(value), ttl, created).run();
				} catch(err) {
					console.log('D1 set error', err);
				}
			}
		};
	}
	
	// Configuration
	
	const config: ServiceConfig = {
		// Various API Keys
		bluesky_api: env.BLUESKY_IDENTIFIER
			? {
				identifier: env.BLUESKY_IDENTIFIER,
				password: env.BLUESKY_PASSWORD as string,
				service: env.BLUESKY_SERVICE
			}
			: undefined,
	
		imgur_api: env.IMGUR_KEY
			? {
				key: [
					env.IMGUR_KEY
				]
			}
			: undefined,
	
		twitch_api: env.TWITCH_ID
			? {
				id: env.TWITCH_ID,
				secret: env.TWITCH_SECRET as string
			}
			: undefined,
	
		youtube_api: env.YOUTUBE_KEY
			? {
				key: env.YOUTUBE_KEY
			}
			: undefined,
	
		// And the keys for the image proxy
		image_proxy: env.PROXY_HOST
			? {
				host: env.PROXY_HOST === 'ALLOW_UNSAFE_IMAGES'
					? LinkService.ALLOW_UNSAFE_IMAGES
					: env.PROXY_HOST,
				key: env.PROXY_KEY
			}
			: undefined,
	
		safe_browsing_server: env.SB_SERVER,
	
		// Set the FFZBot User-Agent, since the default UA doesn't match.
		user_agent: `Mozilla/5.0 (compatible; FFZBot/${LinkService.VERSION}; +https://www.frankerfacez.com)`,
	
		// If we're connected to logging, we'll want to be able to see why
		// a response is returning a bad status code. This is useful for knowing
		// if/how we're hitting bot protections.
		log_error_responses: true,
	
		// Disable these checks because we're running into CPU time limits.
		// TODO: Write another service that does all the safety checks in one
		// fetch call that this service can make.
		use_cloudflare_dns: false,
		use_iplogger_list: false,
	
		// Use a D1 database to cache fediverse checks.
		fedicache: cache,
	
		// mmmagic is unavailable in a worker environment
		use_mmmagic: false,
	}
	
	if ( config.bluesky_api && env.SESSION ) {
		const SESSION = env.SESSION;
		config.bluesky_api.loadSession = () => SESSION.get('bsky-session', {type: 'json'});
		config.bluesky_api.saveSession = data => SESSION.put('bsky-session', JSON.stringify(data));
	}

	return config;
}

let service: LinkService | undefined,
	last_env: Environment | undefined;

function getService(env: Environment): LinkService {
	if ( env !== last_env || ! service ) {
		last_env = env;
		service = new LinkService(buildConfig(env));
		service.registerDefaultResolvers();
	}

	return service;
}


// Here, we define a simple wrapper around the LinkService's resolve
// method so that if multiple requests come into the worker at the same
// time, they will hopefully be de-duplicated into a single request.
const WAIT_MAP: Map<string | URL, Promise<ResolveResult>> = new Map;

function getLink(service: LinkService, link: string, normalized: URL): Promise<ResolveResult> {
	let promise = WAIT_MAP.get(link);
	if ( ! promise ) {
		promise = service.resolve(normalized).finally(() => {
			WAIT_MAP.delete(link);
		});

		WAIT_MAP.set(link, promise);
	}

	return promise;
}

// This is the important method. Here, we:
// 1. Normalize the provided URL.
// 2. Use the normalized URL to check if the response was cached.
// 3. If it was, return the cached response.
// 4. If not, resolve the URL using the LinkService
// 5. Then cache and return that response.
// 6. Also, when returning a response, write an analytics event.

async function handle(
	request: Request,
	origin: string,
	target: string,
	skip_cache: boolean,
	env: Environment,
	ctx: ExecutionContext
): Promise<Response> {

	const cache = caches.default,
		service = getService(env);
	
	// First, use the service to normalize the URL. This doesn't
	// do much, but it gives us a starting point.
	let normalized;
	try {
		normalized = service.normalizeURL(target);
	} catch(err) {
		if ( err instanceof BaseError )
			return responseError(400, err.getMessage());

		console.error(err);
		return responseError(500, "An internal server error occurred.")
	}

	// We need to generate a cache key, which is just a normalized version
	// of the URL due to how Cloudflare's cache works.
	const normalized_str = normalized.toString(),
		cache_url = `${origin}/?url=${encodeURIComponent(normalized_str)}`;

	// If we don't have skip_cache, try reading from the cache.
	let cached: Response | undefined;
	if ( ! skip_cache )
		try {
			cached = await cache.match(cache_url);
		} catch(err) {
			console.error(err);
			return responseError(500, "An internal server error occurred.");
		}

	// If we got a cached result, write an analytics event and then
	// return the cached result.
	if ( cached ) {
		console.log(`Cache hit for: ${cache_url}`);
		if ( env.ANALYTICS )
			writeAnalytics(
				env.ANALYTICS,
				request,
				target,
				normalized.hostname,
				true,
				// We need to make a clone so we don't try reading
				// the same response body twice.
				await cached.clone().json()
			);

		return cached;
	}

	// If we got here, there's no cache.

	// So, let's get a result from the link service.
	let result;
	try {
		result = await getLink(service, normalized_str, normalized);
	} catch (err) {
		console.error(err);
		return responseError(500, "An internal server error occurred.");
	}

	// Write an analytics event.
	if ( env.ANALYTICS )
		writeAnalytics(
			env.ANALYTICS,
			request,
			target,
			normalized.hostname,
			false,
			result
		);

	// Now wrap the response into a JSON object.
	const response = responseJSON(result, {
		headers: {
			'Cache-Control': 'public, max-age=1800'
		}
	});

	// Make sure the response gets written to the server.
	// We need to clone the response to avoid reading the
	// same response body twice.
	ctx.waitUntil(cache.put(cache_url, response.clone()));

	// And return it.
	return response;
}


export default {
	fetch(request: Request, env: Environment, ctx: ExecutionContext) {
		// Handle CORS Pre-Flight Requests
		if ( request.method === 'OPTIONS' )
			return new Response(null, {
				status: 204,
				statusText: 'No Content',
				headers: GLOBAL_HEADERS
			});

		// Parse the URL for routing and stuff.
		const url = new URL(request.url);

		// If we get a request for /ips, return a list of IP addresses
		// that are relevant.
		// TODO: Stop hardcoding this
		if ( url.pathname === '/ips' )
			return responseJSON({
				"$comment": "Most FFZBot traffic comes from Cloudflare, as the bot is implemented as a Cloudflare Worker. The \"CF-Worker\" header should contain the value \"frankerfacez.com\" to verify the Worker is owned and operated by FrankerFaceZ. See https://docs.frankerfacez.com/dev/link-preview/robot for more on how to verify the identity of FFZBot.",
				ipv4: [
					'158.69.219.9'
				],
				ipv6: []
			});

		// If we get a request for /examples, return a list of example
		// URLs from the service. This is lightweight and won't be called
		// much so don't even bother with caching headers or anything.
		if ( url.pathname === '/examples' )
			return responseJSON({
				examples: getService(env).getExamples()
			});

		// Any other URL besides / is a 404.
		else if ( url.pathname !== '/' )
			return responseError(404, "Not Found");

		// Now that we're handling root requests, check to see if the
		// request included a target URL.
		const target = url.searchParams.get('url');

		// If there's no target URL, and this is a navigate event (such
		// as a user opening the URL directly) then redirect to the
		// documentation website.
		//
		// If this is not a navigate event, then return a 400 error because
		// no URL was provided.
		if ( ! target ) {
			const mode = request.headers.get('sec-fetch-mode');
			if ( mode === 'navigate' )
				return responseRedirect('https://docs.frankerfacez.com/dev/link-preview/robot');

			return responseError(400, "No URL was provided.");
		}

		// Check if this request should skip the cache or not.
		const skip_cache = url.searchParams.get('skip_cache') === '1';

		// We do not let bots skip the cache, so check right now if this
		// is a bot and forbid it.
		if ( skip_cache ) {
			const ua = request.headers.get('user-agent');
			if ( isbot(ua) )
				return responseError(403, "Bots are not allowed to use skip_cache at this time.");
		}

		// Got here? Move over to the handle method then.
		return handle(request, url.origin, target, skip_cache, env, ctx);
	}
}
