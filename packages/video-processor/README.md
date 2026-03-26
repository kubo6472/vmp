# Video Processor Admin (Cloudflare Pages)

Simple admin interface for:

- Drag-and-drop video uploads into Cloudflare R2 using the [tus resumable upload protocol](https://tus.io/).
- Triggering processing placeholder logic in Cloudflare Pages Functions.
- Applying visibility tags (`private`, `unlisted`, `public`).
- Listing processed videos.

## Local development

```bash
npm run dev --workspace @vmp/video-processor
```

## Deploy

```bash
npm run deploy --workspace @vmp/video-processor
```

## Upload flow

- Client uses `tus-js-client` in the admin page.
- `POST /api/uploads` creates a multipart upload session in R2 and returns a tus upload URL.
- `PATCH /api/uploads/:videoId` appends chunks as multipart parts.
- `HEAD /api/uploads/:videoId` reports resumable offset.

## Required Cloudflare bindings

Set up an R2 bucket binding in `wrangler.toml`:

- `VIDEO_BUCKET`
