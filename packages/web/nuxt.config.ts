export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  
  modules: ['@nuxtjs/tailwindcss'],
  
  runtimeConfig: {
    public: {
      apiUrl: process.env.API_URL || 'https://vmp-api.tjm.sk'
    }
  },
  
  app: {
    head: {
      title: 'VMP - Video Monetization Platform',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Premium video content platform' }
      ]
    }
  }
})