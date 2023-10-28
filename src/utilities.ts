import { ErrorDocument, ResolveResult } from "@ffz/link-service";
import { GLOBAL_HEADERS } from "./constants";
import isbot from "isbot";

export type SimpleResponseInit = {
    status?: number;
    headers?: Record<string, string>;
}

export function responseJSON(obj: any, opts?: SimpleResponseInit) {
    if ( ! opts )
        opts = {};

    if ( ! opts.headers )
        opts.headers = {
            ...GLOBAL_HEADERS
        };

    else
        for(const [key, val] of Object.entries(GLOBAL_HEADERS)) {
            if ( ! opts.headers[key] )
                opts.headers[key] = val;
        }
    
    opts.headers['Content-Type'] = 'application/json;charset=UTF-8';
    return new Response(JSON.stringify(obj), opts);
}


export function responseRedirect(url: string | URL, code: number = 302, opts?: SimpleResponseInit) {
    if ( ! opts )
        opts = {};

    if ( ! opts.headers )
        opts.headers = {
            ...GLOBAL_HEADERS
        };

    else
        for(const [key, val] of Object.entries(GLOBAL_HEADERS)) {
            if ( ! opts.headers[key] )
                opts.headers[key] = val;
        }

    opts.headers['Location'] = String(url);
    opts.status = code;

    return new Response(null, opts);
}


export function responseError(status: number, msg: any) {
    return responseJSON({
        status,
        error: msg
    }, {
        status
    });
}

/**
 * Write an analytics event. This should be called every
 * time a ResolveResult is returned to a user so long as
 * ANALYTICS is available.
 * 
 * We don't want to store information about the end user
 * when we don't have to, and we want to limit information
 * about URLs being requested as well.
 * 
 * To that end, we only store the request's User-Agent
 * string if it's detected as a bot User-Agent. We are
 * interested in bot User-Agents so we can monitor traffic
 * in case of abuse.
 * 
 * We store the origin header's value so that we can get
 * an idea on where traffic to the service is originating.
 * Most traffic should come from browser clients, so this
 * should almost always be set.
 * 
 * We only store the requested target URL if one of these
 * conditions is true:
 *    - The request hit the maximum redirect limit of 20.
 * 
 * @param request The HTTP request being responded to.
 * @param target The target URL that was requested.
 * @param hostname The hostname of the target URL.
 * @param cached Whether or not this response was read from cache.
 * @param response The response being returned.
 */
export function writeAnalytics(
    dataset: AnalyticsEngineDataset,
    request: Request,
    target: string,
    hostname: string,
    cached: boolean,
    response?: ResolveResult
) {

    const agent = request.headers.get('User-Agent'),
        is_bot = isbot(agent),
        visited_urls = response?.urls?.length ?? 1,

        save_url = visited_urls >= 20;

    dataset.writeDataPoint({
        indexes: [
            // index1: hostname
            hostname
        ],

        blobs: [
            // blob1: Cloudflare Location
            request.cf?.colo as string,

            // blob2: Bot User Agent,
            is_bot ? agent : null,

            // blob3: Request Origin
            request.headers.get('Origin'),

            // blob4: Request URL (for Max Redirects)
            save_url ? target : null
        ],

        doubles: [
            // double1: cached
            cached ? 1 : 0,

            // double2: errored
            (response as ErrorDocument)?.error ? 1 : 0,

            // double3: unsafe
            response?.unsafe ? 1 : 0,

            // double4: visited URL count
            visited_urls,

            // double5: is bot
            is_bot ? 1 : 0,

            // double6: http status code
            response?.status ?? 0
        ]
    });

}