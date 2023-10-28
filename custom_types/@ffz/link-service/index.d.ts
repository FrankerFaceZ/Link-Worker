
declare module '@ffz/link-service' {

    export type CacheResult = {
        hit: boolean;
        value: any
    };

    export type CacheOptions = {
        ttl?: number;
    };

    export interface CacheInterface {
        get(key: string, options?: CacheOptions): Promise<CacheResult>;
        set(key: string, value: any, options?: CacheOptions): Promise<void>;
    }

    export type ServiceConfig = {
        bluesky_api?: {
            identifier: string;
            password: string;
            service?: string | null;

            loadSession?: () => Promise<any>;
            saveSession?: (data: any) => Promise<void>;

        };

        cache?: CacheInterface | null,
        fedicache?: CacheInterface | null,

        imgur_api?: {
            key: string[]
        };

        twitch_api?: {
            id: string;
            secret: string;
        };

        youtube_api?: {
            key: string;
        };

        max_redirects?: number;
        domain_cache_size?: number;
        disable_tags?: boolean;
        safe_browsing_server?: string;
        use_cloudflare_dns?: boolean;
        use_dnszero?: boolean;
        use_shortener_list?: boolean;
        use_grabify_check?: boolean;
        use_iplogger_list?: boolean;
        use_mmmagic?: boolean;
        log_error_responses?: boolean;
        user_agent?: string;
        default_referrer?: boolean;
        resolver_timeout?: boolean;

        image_proxy?: {
            host: string | typeof LinkService.ALLOW_UNSAFE_IMAGES;
            key?: string | null;
        };
    };


    export type Token = Token[] | RichToken | PrimitiveToken | null;

    export type PrimitiveToken = string | number | boolean;

    export type RichToken = {
        type: string
    };

    export type RichDocument = {
        v: number;
    };

    export type ErrorDocument = {
        error: Token;
    };

    export type ExampleUrl = {
        url: string;
        resolver: string;
    };

    export type UrlInfo = {
        url: string;
        resolver: string | null;
        unsafe: boolean;
        shortened: boolean;
        flags: string[];
    };

    export type ResolveMetadata = {
        status: number | null;
        unsafe: boolean;
        urls: UrlInfo[];
    };

    export type ResolveResult = ResolveMetadata & (RichDocument | ErrorDocument);


    export class BaseError extends Error {

        constructor(message?: string, extra?: any);

        getMessage(): Token;

    }


    export default class LinkService {
        static VERSION: string;
        static readonly ALLOW_UNSAFE_IMAGES: unique symbol;

        constructor(config: ServiceConfig);

        registerDefaultResolvers(): void;

        normalizeURL(url: string | URL, base?: string | URL): URL;
        
        getExamples(): ExampleUrl[];

        resolve(link: string | URL): Promise<ResolveResult>;
    }
    
}