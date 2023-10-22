
import LinkService, { BaseError, type ResolveResult, type ServiceConfig } from '@ffz/link-service';
import isbot from 'isbot';

import { responseError, responseJSON, responseRedirect, writeAnalytics } from './utilities';
import { GLOBAL_HEADERS } from './constants';

declare const BLUESKY_IDENTIFIER: string | undefined;
declare const BLUESKY_PASSWORD: string | undefined;
declare const BLUESKY_SERVICE: string | undefined;
declare const IMGUR_KEY: string | undefined;
declare const TWITCH_ID: string | undefined;
declare const TWITCH_SECRET: string | undefined;
declare const YOUTUBE_KEY: string | undefined;
declare const PROXY_HOST: string | undefined;
declare const PROXY_KEY: string | undefined;
declare const SB_SERVER: string | undefined;

declare const ANALYTICS: AnalyticsEngineDataset | undefined;
declare const SESSION: KVNamespace | undefined;


// Configuration

const CONFIG: ServiceConfig = {
	// Various API Keys
	bluesky_api: typeof BLUESKY_IDENTIFIER === 'string' && BLUESKY_IDENTIFIER
		? {
			identifier: BLUESKY_IDENTIFIER,
			password: BLUESKY_PASSWORD as string,
			service: typeof BLUESKY_SERVICE === 'string'
				? BLUESKY_SERVICE : undefined
		}
		: undefined,

	imgur_api: typeof IMGUR_KEY === 'string' && IMGUR_KEY
		? {
			key: [
				IMGUR_KEY
			]
		}
		: undefined,

	twitch_api: typeof TWITCH_ID === 'string' && TWITCH_ID
		? {
			id: TWITCH_ID,
			secret: TWITCH_SECRET as string
		}
		: undefined,

	youtube_api: typeof YOUTUBE_KEY === 'string' && YOUTUBE_KEY
		? {
			key: YOUTUBE_KEY
		}
		: undefined,

	// And the keys for the image proxy
	image_proxy: typeof PROXY_HOST === 'string'
		? {
			host: PROXY_HOST === 'ALLOW_UNSAFE_IMAGES'
				? LinkService.ALLOW_UNSAFE_IMAGES
				: PROXY_HOST,
			key: typeof PROXY_KEY === 'string'
				? PROXY_KEY : null
		}
		: undefined,

	safe_browsing_server: typeof SB_SERVER === 'string'
		? SB_SERVER
		: undefined,

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

	// mmmagic is unavailable in a worker environment
	use_mmmagic: false,
}

if ( CONFIG.bluesky_api && typeof SESSION !== 'undefined' ) {
	CONFIG.bluesky_api.loadSession = () => SESSION.get('bsky-session', {type: 'json'});
	CONFIG.bluesky_api.saveSession = data => SESSION.put('bsky-session', JSON.stringify(data));
}

// Now, create the service instance and set it up with all the default resolvers.
const service = new LinkService(CONFIG);
service.registerDefaultResolvers();


// Here, we define a simple wrapper around the LinkService's resolve
// method so that if multiple requests come into the worker at the same
// time, they will hopefully be de-duplicated into a single request.
const WAIT_MAP: Map<string | URL, Promise<ResolveResult>> = new Map;

function getLink(link: string, normalized: URL): Promise<ResolveResult> {
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
	event: FetchEvent,
	origin: string,
	target: string,
	skip_cache: boolean
): Promise<Response> {

	const cache = caches.default;
	
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
		if ( typeof ANALYTICS !== 'undefined' )
			writeAnalytics(
				event.request,
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
		result = await getLink(normalized_str, normalized);
	} catch (err) {
		console.error(err);
		return responseError(500, "An internal server error occurred.");
	}

	// Write an analytics event.
	if ( typeof ANALYTICS !== 'undefined' )
		writeAnalytics(
			event.request,
			target,
			normalized.hostname,
			false,
			result
		);

	// Now wrap the response into a JSON object.
	const response = responseJSON(result, {
		headers: {
			'Cache-Control': 'public, max-age=300'
		}
	});

	// Make sure the response gets written to the server.
	// We need to clone the response to avoid reading the
	// same response body twice.
	event.waitUntil(cache.put(cache_url, response.clone()));

	// And return it.
	return response;
}


addEventListener('fetch', (event: FetchEvent) => {
	// TODO: Origin checking

	// Handle CORS Pre-Flight Requests
	if ( event.request.method === 'OPTIONS' ) {
		const resp = new Response(null, {
			status: 204,
			statusText: 'No Content',
			headers: GLOBAL_HEADERS
		});

		event.respondWith(resp);
		return;
	}

	// Parse the URL for routing and stuff.
	const url = new URL(event.request.url);

	// If we get a request for /ips, return a list of IP addresses
	// that are relevant.
	// TODO: Stop hardcoding this
	if ( url.pathname === '/ips' ) {
		event.respondWith(responseJSON({
			"$comment": "Most FFZBot traffic comes from Cloudflare, as the bot is implemented as a Cloudflare Worker. The \"CF-Worker\" header should contain the value \"frankerfacez.com\" to verify the Worker is owned and operated by FrankerFaceZ. See https://docs.frankerfacez.com/dev/link-preview/robot for more on how to verify the identity of FFZBot.",
			ipv4: [
				'158.69.219.9'
			],
			ipv6: []
		}));
		return;
	}

	// If we get a request for /examples, return a list of example
	// URLs from the service. This is lightweight and won't be called
	// much so don't even bother with caching headers or anything.
	if ( url.pathname === '/examples' ) {
		event.respondWith(responseJSON({
			examples: service.getExamples()
		}));
		return;
	}

	// Any other URL besides / is a 404.
	else if ( url.pathname !== '/' ) {
		event.respondWith(responseError(404, "Not Found"));
		return;
	}

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
		const mode = event.request.headers.get('sec-fetch-mode');
		if ( mode === 'navigate' ) {
			event.respondWith(responseRedirect('https://docs.frankerfacez.com/dev/link-preview/robot'));
			return;
		}

		event.respondWith(responseError(400, "No URL was provided."));
		return;
	}

	// Check if this request should skip the cache or not.
	const skip_cache = url.searchParams.get('skip_cache') === '1';

	// We do not let bots skip the cache, so check right now if this
	// is a bot and forbid it.
	if ( skip_cache ) {
		const ua = event.request.headers.get('user-agent');
		if ( isbot(ua) ) {
			event.respondWith(responseError(403, "Bots are not allowed to use skip_cache at this time."));
			return;
		}
	}

	// Got here? Move over to the handle method then.
	event.respondWith(handle(event, url.origin, target, skip_cache));
});
