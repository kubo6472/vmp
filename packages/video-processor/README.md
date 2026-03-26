# Video Processor Admin (Cloudflare Pages)

Simple admin interface for:

- Drag-and-drop video uploads into Cloudflare R2 using the [tus resumable upload protocol](https://tus.io/).
- Triggering processing logic in Cloudflare Pages Functions that writes `.ts` segment objects and an HLS playlist.
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


## Processing output

`POST /api/process` now emits:

- `videos/:videoId/processed/segments/segment_0000.ts` style segment objects
- `videos/:videoId/processed/playlist.m3u8` referencing those segment keys
- `videos/:videoId/metadata.json` including the generated `segmentKeys`

Processing reads the source object from R2 in ranged chunks to avoid loading the entire source file into worker memory.
