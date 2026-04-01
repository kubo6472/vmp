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
        { name: 'description', content: 'Premium video content platform' }
      ]
    }
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'VMP',
      short_name: 'VMP',
      description: 'Premium video content',
      start_url: '/',
      theme_color: '#0f172a',
      background_color: '#0f172a',
      display: 'standalone',
      icons: [
        { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
        // purpose 'any maskable' satisfies Chrome's installability requirement
        { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
    },
    client: {
      installPrompt: true,
    },
    // Enable service worker in dev so you can test installation without a prod build
    devOptions: {
      enabled: true,
      type: 'module',
    },
  },
})
