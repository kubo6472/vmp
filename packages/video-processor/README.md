# Video Processor Admin (Cloudflare Pages)

Simple admin interface for:

- Drag-and-drop video uploads into Cloudflare R2.
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

## Required Cloudflare bindings

Set up an R2 bucket binding in `wrangler.toml`:

- `VIDEO_BUCKET`
