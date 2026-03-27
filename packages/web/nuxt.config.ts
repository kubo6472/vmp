export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  
  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/color-mode'],
  
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
      apiUrl: process.env.API_URL || 'https://vmp-api.tjm.sk'
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
  }
})