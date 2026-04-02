export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },

  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/color-mode', '@vite-pwa/nuxt'],

  colorMode: {
    preference: 'system', // default value of $colorMode.preference
    fallback: 'dark', // fallback value if not system preference found
    classSuffix: '', // use just 'dark' and 'light' classes
  },

  vite: {
    optimizeDeps: {
      include: [
        '@vue/devtools-core',
        '@vue/devtools-kit',
        'media-chrome',
        'videojs-video-element',
      ]
    }
  },

  runtimeConfig: {
    public: {
      apiUrl: process.env.API_URL || 'https://vmp-api.tjm.sk',
    }
  },

  app: {
    head: {
      title: 'Video Monetization Platform',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Premium video content platform' },
        // Required by Chrome's PWA installability check
        { name: 'theme-color', content: '#0f172a' },
      ],
      link: [
        // Belt-and-suspenders: @vite-pwa/nuxt injects this automatically, but
        // some Nitro presets miss the injection step — add it explicitly too.
        { rel: 'manifest', href: '/manifest.webmanifest' },
        // iOS home screen icon (Safari ignores the web manifest icons array)
        { rel: 'apple-touch-icon', href: '/icons/pwa-192.png' },
      ],
    }
  },

  pwa: {
    registerType: 'autoUpdate',
    // 'auto' lets vite-plugin-pwa choose the best registration strategy for
    // the current environment (inline script in <head> during SSR builds).
    injectRegister: 'auto',
    manifest: {
      name: 'VMP',
      short_name: 'VMP',
      description: 'Premium video content',
      start_url: '/',
      scope: '/',
      theme_color: '#0f172a',
      background_color: '#0f172a',
      display: 'standalone',
      icons: [
        { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        // Separate maskable entry required by Chrome's installability audit
        { src: '/icons/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
      cleanupOutdatedCaches: true,
    },
    client: {
      installPrompt: true,
    },
    devOptions: {
      // Set to true locally if you need to test the service worker in dev mode.
      // Leave false for production — the module handles that path separately.
      enabled: false,
      type: 'classic', // Workbox uses importScripts(); must not be 'module'
    },
  },
})
