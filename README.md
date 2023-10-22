# FFZBot Cloudflare Worker

This is a Cloudflare Worker that exposes the [@ffz/link-service](https://github.com/FrankerFaceZ/Link-Service) [![NPM Version](https://img.shields.io/npm/v/@ffz/link-service.svg?style=flat)](https://npmjs.org/package/@ffz/link-service) project to HTTP clients.

I don't expect anyone to need to run this themselves, but if you want to run a
copy of the link preview service, this is how you'd do it.

If you just want to implement a new resolver for a website, or change how a resolver
works, you should check out the [Link-Service](https://github.com/FrankerFaceZ/Link-Service) project instead.


## How to Use

Please note that these instructions assume you already know how to use
Cloudflare's Worker platform, along with the `wrangler` tool.

1. Fork the project.

2. Copy `wrangler.toml.example` to `wrangler.toml`, and make the
   following chanages:
   1. Replace `account_id` with your own `account_id`, or just remove the line.

   2. Update the `dataset` in `analytics_engine_datasets` with the name of the
      dataset you want to store events in, or just remove the block to disable
      analytics events.

   4. Update the `id` in `kv_namespaces` to point to a KV namespace associated
      with your account, or just remove the block to disable Bluesky session
      caching. Please note that it is not recommended to do this, as Bluesky
      has strict login limits that a live service is very likely to run into
      without a session cache.

3. Make a copy of `env.sample` and name it `.dev.vars`, then update it with
   all the necessary API keys. If you don't have an API key for a given service
   just remove the relevant lines and that service's resolver will be disabled.

4. Run the worker locally with `pnpm dev` and use our
   [testing tool](https://docs.frankerfacez.com/dev/link-preview/tester) with
   the Provider set to "Local Dev Worker" to ensure that the service is running
   as expected.

   Please note that your browser will need to trust self-signed certificates
   from localhost or this will fail.


## How to Deploy

Following along from the previous instructions:

5. Assuming everything has gone to plan, upload your secrets from `.dev.vars`
   using wrangler.

6. Finally, run `pnpm wrangler deploy` to deploy the worker.


## About Environment Variables

Here's a quick overview of the available environment variables:

### `BLUESKY_IDENTIFIER`

In order to use enhanced API-based functionality for [Bluesky](https://bsky.app/),
you need to provide at a minimum `BLUESKY_IDENTIFIER` and `BLUESKY_PASSWORD`.

This is your Bluesky email address or handle, for use when authenticating against
Bluesky in the event that there is no cached session to resume.

### `BLUESKY_PASSWORD`

This is an app password for your Bluesky account. Do not use your main password.
Just create an app password at: https://bsky.app/settings/app-passwords

### `BLUESKY_SERVICE`

*Optional.* This is the URL used when constructing a Bluesky agent for
accessing the Bluesky network. By default, if you don't provide this,
the link service will use `https://bsky.social`

### `IMGUR_KEY`

In order to use enhanced API-based functionality for [Imgur](https://imgur.com/),
you need to provide an `IMGUR_KEY`.

This is your Imgur API key. See Imgur's API documentation for details on using
the API and registering for a key.

### `TWITCH_ID`

In order to use enhanced API-based functionality for [Twitch](https://twitch.tv),
you need to provide at a minimum `TWITCH_ID` and `TWITCH_SECRET`.

This is your Twitch application's Client ID.

### `TWITCH_SECRET`

This is your Twitch application's Client Secret.

### `YOUTUBE_KEY`

In order to use enhanced API-based functionality for [YouTube](https://www.youtube.com), you need to provide a `YOUTUBE_KEY`.

This is your YouTube API key.

### `PROXY_HOST`

The link preview service is written with end-user privacy in mind, and so it's
designed not to leak HTTP requests from the client to the target server. Part
of that is proxying requests to images.

This should be the URL of a server running [imageproxy](https://github.com/willnorris/imageproxy) for the construction of image URLs.

It's highly recommended you also include a `PROXY_KEY` to sign URLs so that
bad actors cannot use your image proxy as an open redirect / open proxy.

If you want to disable image proxying behavior, and just return direct URLs,
then you can set this to the special string `ALLOW_UNSAFE_IMAGES`.

Leaving this value out will result in images being stripped from responses.

### `PROXY_KEY`

A secret key for signing image URLs, to be used with `PROXY_HOST`.

### `SB_SERVER`

*Optional.* The URL to a [SafeBrowsing](https://github.com/google/safebrowsing)
proxy server, for doing URL safety checks. 

This uses the `/v4/threatMatches:find` endpoint, so any server implementation
you use will need to support that endpoint.
