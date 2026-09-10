<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <!-- PWA install prompt banner -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 -translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div v-if="showPwaBanner" class="bg-blue-600 text-white px-4 py-2.5">
        <div class="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <p class="text-sm font-medium">{{ strings.pwaInstallPrompt }}</p>
          <div class="flex items-center gap-2 shrink-0">
            <button
              class="px-3 py-1 text-xs font-semibold bg-white text-blue-700 rounded-md hover:bg-blue-50 transition-colors"
              @click="installPwa"
            >
              {{ strings.pwaInstall }}
            </button>
            <button
              class="p-1 rounded-md hover:bg-blue-500 transition-colors"
              :aria-label="strings.dismiss"
              @click="dismissPwaBanner"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="mb-8">
        <div v-if="pills.length" class="mt-5 flex flex-wrap gap-3 overflow-x-auto pb-1">
          <div
            v-for="pill in pills"
            :key="pill.id"
            class="flex items-center gap-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-2.5 shadow-sm min-w-[140px]"
          >
            <div
              v-if="pill.image_url"
              class="w-10 h-10 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-800 flex-shrink-0"
            >
              <img
                :src="pill.image_url"
                :alt="pill.label"
                class="w-full h-full object-cover"
                loading="lazy"
                decoding="async"
              >
            </div>
            <div
              v-else
              class="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-white text-sm font-bold"
              :style="{ backgroundColor: pill.color || '#2563eb' }"
            >
              {{ pill.label?.charAt(0)?.toUpperCase() || '?' }}
            </div>
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white truncate leading-tight">
                {{ pill.label }}
              </p>
              <p
                class="text-lg font-bold leading-tight"
                :style="{ color: pill.color || '#2563eb' }"
              >
                {{ formatPillValue(pill) }}
              </p>
              <a
                v-if="pill.value_mode === 'graph_embed' && pill.graph_embed_url"
                :href="pill.graph_embed_url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >{{ strings.openGraph }}</a
              >
            </div>
          </div>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="text-center py-20">
        <div
          class="inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"
        ></div>
        <p class="mt-4 text-gray-600 dark:text-gray-400">{{ strings.loadingVideos }}</p>
      </div>

      <!-- Error State -->
      <div
        v-else-if="error"
        class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6"
      >
        <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">
          {{ strings.errorLoadingVideos }}
        </h3>
        <p class="text-red-700 dark:text-red-300">{{ error }}</p>
      </div>

      <div v-else-if="homepageRenderModel.blockItems.length > 0" class="space-y-8">
        <section
          v-for="block in homepageRenderModel.blockItems"
          :key="`home-block-${block.id}`"
          class="space-y-3"
        >
          <div v-if="block.title || block.body">
            <h2 v-if="block.title" class="text-xl font-bold text-gray-900 dark:text-white">
              {{ block.title }}
            </h2>
            <p v-if="block.body" class="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {{ block.body }}
            </p>
          </div>

          <div v-if="block.type === 'top_video'" class="space-y-4">
            <VideoCard
              v-for="video in block.videos"
              :key="`top-video-${video.id}`"
              :video="video"
              layout="horizontal"
              title-scale="hero"
              :show-description="false"
              :show-relative-timestamp="true"
              :clamp-title="false"
              :image-loading="videoCardImageLoading(video.id)"
              :image-fetch-priority="videoCardImageFetchPriority(video.id)"
            />
          </div>

          <div
            v-else-if="block.type === 'featured_row'"
            class="grid grid-cols-1 sm:grid-cols-2 gap-5"
          >
            <VideoCard
              v-for="video in block.videos"
              :key="`featured-row-${video.id}`"
              :video="video"
              :show-description="false"
              :show-relative-timestamp="true"
              :clamp-title="false"
              :image-loading="videoCardImageLoading(video.id)"
              :image-fetch-priority="videoCardImageFetchPriority(video.id)"
            />
          </div>

          <div
            v-else-if="block.type === 'page_banner'"
            class="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
          >
            <NuxtLink :to="`/${block.pageSlug}`" class="block" :aria-label="bannerLinkLabel(block)">
              <picture>
                <source
                  v-if="block.mobileImageId && bannerImageUrls[block.mobileImageId]"
                  media="(max-width: 1023px)"
                  :srcset="bannerImageUrls[block.mobileImageId]"
                >
                <img
                  v-if="bannerImageUrls[block.imageId]"
                  :src="bannerImageUrls[block.imageId]"
                  :alt="bannerImageAlt(block)"
                  class="w-full h-auto object-cover"
                  loading="lazy"
                >
              </picture>
            </NuxtLink>
          </div>

          <div v-else-if="block.type === 'category'" class="space-y-2">
            <div v-if="block.categorySection" class="flex items-center justify-between">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
                {{ block.categorySection.category.name }}
              </h3>
              <NuxtLink
                :to="`/category/${block.categorySection.category.slug}`"
                class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
              >
                {{ strings.categoryMoreLink }}
              </NuxtLink>
            </div>
            <div
              v-if="block.categorySection"
              class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5"
            >
              <VideoCard
                v-for="video in block.categorySection.visible"
                :key="`category-block-${block.id}-${video.id}`"
                :video="video"
                :show-description="false"
                :show-relative-timestamp="true"
                :clamp-title="false"
                :image-loading="videoCardImageLoading(video.id)"
                :image-fetch-priority="videoCardImageFetchPriority(video.id)"
              />
            </div>
          </div>
          <div
            v-else-if="block.type === 'category_with_side_mini'"
            class="grid grid-cols-1 xl:grid-cols-3 gap-5"
          >
            <section class="xl:col-span-2 space-y-3">
              <div v-if="block.primary.categorySection" class="flex items-center justify-between">
                <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
                  {{ block.primary.categorySection.category.name }}
                </h3>
                <NuxtLink
                  :to="`/category/${block.primary.categorySection.category.slug}`"
                  class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {{ strings.categoryMoreLink }}
                </NuxtLink>
              </div>
              <div
                v-if="block.primary.categorySection"
                class="grid grid-cols-1 sm:grid-cols-2 gap-5"
              >
                <VideoCard
                  v-for="video in block.primary.categorySection.visible"
                  :key="`paired-main-${block.primary.id}-${video.id}`"
                  :video="video"
                  :show-description="false"
                  :show-relative-timestamp="true"
                  :clamp-title="false"
                  :image-loading="videoCardImageLoading(video.id)"
                  :image-fetch-priority="videoCardImageFetchPriority(video.id)"
                />
              </div>
            </section>
            <aside class="space-y-3">
              <div v-if="block.sideMini.categorySection" class="flex items-center justify-between">
                <h3 class="text-base font-semibold text-gray-900 dark:text-white">
                  {{ block.sideMini.categorySection.category.name }}
                </h3>
                <NuxtLink
                  :to="`/category/${block.sideMini.categorySection.category.slug}`"
                  class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {{ strings.categoryMoreLink }}
                </NuxtLink>
              </div>
              <div v-if="block.sideMini.categorySection" class="space-y-4">
                <VideoCard
                  v-for="video in block.sideMini.categorySection.visible"
                  :key="`paired-side-${block.sideMini.id}-${video.id}`"
                  :video="video"
                  layout="horizontal"
                  :show-description="false"
                  :show-relative-timestamp="true"
                  :clamp-title="false"
                  :image-loading="videoCardImageLoading(video.id)"
                  :image-fetch-priority="videoCardImageFetchPriority(video.id)"
                />
              </div>
            </aside>
          </div>

          <div
            v-else-if="block.type === 'split_horizontal' || block.type === 'split_vertical'"
            class="grid gap-4"
            :class="block.type === 'split_horizontal' ? 'md:grid-cols-2' : 'grid-cols-1'"
          >
            <section
              v-for="child in block.children"
              :key="`split-child-${child.id}`"
              class="rounded-lg border border-gray-200 dark:border-gray-800 p-4 space-y-3 bg-white dark:bg-gray-900"
            >
              <div v-if="child.title || child.body">
                <h3 v-if="child.title" class="font-semibold text-gray-900 dark:text-white">
                  {{ child.title }}
                </h3>
                <p v-if="child.body" class="text-sm text-gray-600 dark:text-gray-400">
                  {{ child.body }}
                </p>
              </div>
              <div v-if="child.type === 'top_video'" class="space-y-3">
                <VideoCard
                  v-for="video in child.videos"
                  :key="`split-top-${child.id}-${video.id}`"
                  :video="video"
                  layout="horizontal"
                  title-scale="hero"
                  :show-description="false"
                  :show-relative-timestamp="true"
                  :clamp-title="false"
                  :image-loading="videoCardImageLoading(video.id)"
                  :image-fetch-priority="videoCardImageFetchPriority(video.id)"
                />
              </div>
              <div
                v-else-if="child.type === 'featured_row'"
                class="grid grid-cols-1 sm:grid-cols-2 gap-4"
              >
                <VideoCard
                  v-for="video in child.videos"
                  :key="`split-featured-${child.id}-${video.id}`"
                  :video="video"
                  :show-description="false"
                  :show-relative-timestamp="true"
                  :clamp-title="false"
                  :image-loading="videoCardImageLoading(video.id)"
                  :image-fetch-priority="videoCardImageFetchPriority(video.id)"
                />
              </div>
              <div v-else-if="child.categorySection" class="space-y-2">
                <div class="flex items-center justify-between">
                  <h4 class="font-semibold text-gray-900 dark:text-white">
                    {{ child.categorySection.category.name }}
                  </h4>
                  <NuxtLink
                    :to="`/category/${child.categorySection.category.slug}`"
                    class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {{ strings.categoryMoreLink }}
                  </NuxtLink>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <VideoCard
                    v-for="video in child.categorySection.visible"
                    :key="`split-category-${child.id}-${video.id}`"
                    :video="video"
                    :show-description="false"
                    :show-relative-timestamp="true"
                    :clamp-title="false"
                    :image-loading="videoCardImageLoading(video.id)"
                    :image-fetch-priority="videoCardImageFetchPriority(video.id)"
                  />
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>

      <div
        v-else-if="videos.length > 0"
        class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5"
      >
        <VideoCard
          v-for="video in videos"
          :key="`home-fallback-${video.id}`"
          :video="video"
          :show-description="false"
          :show-relative-timestamp="true"
          :clamp-title="false"
          :image-loading="videoCardImageLoading(video.id)"
          :image-fetch-priority="videoCardImageFetchPriority(video.id)"
        />
      </div>

      <!-- Empty State -->
      <div v-else class="text-center py-20">
        <div
          class="w-16 h-16 mx-auto mb-4 bg-gray-200 dark:bg-gray-800 rounded-full flex items-center justify-center"
        >
          <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          {{ strings.noVideosTitle }}
        </h3>
        <p class="text-gray-600 dark:text-gray-400">{{ strings.noVideosSubtitle }}</p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
  import type {
    HomepageLayoutBlock,
    HomepagePlacementResponse,
    HomepageRenderPageBannerBlock,
  } from '~/composables/useHomepageLayout';
  import {
    buildHomepageRenderModel,
    orderLayoutBlocksForViewport,
  } from '~/composables/useHomepageLayout';
  import { sizeUrl } from '~/composables/useThumbnail';
  import { useVideoStartupPrefetch } from '~/composables/useVideoStartupPrefetch';
  import { fetchCmsMediaUrls } from '~/utils/fetchCmsMediaUrls';
  import strings from '~/utils/strings';

  const { siteSettings } = useSiteSettings();
  const { isLoggedIn, authHeader } = useAuth();
  usePageSeo(
    computed(() => ({
      description: siteSettings.value.siteDescription,
      image: siteSettings.value.logoUrl || undefined,
    })),
  );

  // ── PWA install banner ────────────────────────────────────────────────────────
  const { $pwa } = useNuxtApp();
  const pwaBannerDismissed = ref(false);
  /** Defer until after mount so SSR HTML matches the first client paint (avoids hydration mismatch). */
  const pwaBannerReady = ref(false);
  const showPwaBanner = computed(
    () => pwaBannerReady.value && !pwaBannerDismissed.value && !!($pwa as any)?.showInstallPrompt,
  );
  function installPwa() {
    ($pwa as any)?.install?.();
    pwaBannerDismissed.value = true;
  }
  function dismissPwaBanner() {
    pwaBannerDismissed.value = true;
  }

  const config = useRuntimeConfig();

  const { enqueueMany: enqueueVideoStartupPrefetchMany } = useVideoStartupPrefetch({
    apiUrl: String(config.public.apiUrl),
    authHeaders: () => authHeader(),
    isLoggedIn,
    segmentCount: 3,
  });

  type HomePill = {
    id: string;
    label: string;
    value: number;
    value_secondary?: number | null;
    value_mode?: 'number' | 'percentage' | 'agree_disagree' | 'graph_embed';
    graph_embed_url?: string | null;
    graph_payload_json?: string | null;
    color: string;
    image_url?: string;
  };

  type HomepageContentResponse = {
    homepageConfig?: {
      layoutBlocks?: HomepageLayoutBlock[];
    };
  };

  type PillsResponse = {
    pills?: HomePill[];
  };

  const homepageContentAsync = useAsyncData('homepage-content', () =>
    $fetch<HomepageContentResponse>(`${config.public.apiUrl}/api/homepage/content`),
  );
  const placementAsync = useAsyncData('homepage-placement', () =>
    $fetch<HomepagePlacementResponse>(`${config.public.apiUrl}/api/homepage/placement`),
  );
  const pillsAsync = useAsyncData('homepage-pills', () =>
    $fetch<PillsResponse>(`${config.public.apiUrl}/api/pills`),
  );

  await Promise.all([homepageContentAsync, placementAsync, pillsAsync]);

  const {
    data: homepageContent,
    pending: homepageContentPending,
    error: homepageContentError,
  } = homepageContentAsync;

  const { data: placementData, pending: placementPending, error: placementError } = placementAsync;

  const { data: pillsData, pending: pillsPending, error: pillsError } = pillsAsync;

  const layoutBlocks = computed(() => {
    const blocks = homepageContent.value?.homepageConfig?.layoutBlocks;
    return Array.isArray(blocks) ? blocks : [];
  });
  const placement = computed(() => placementData.value ?? null);
  const videos = computed<any[]>(() =>
    Array.isArray(placementData.value?.videos) ? placementData.value.videos : [],
  );
  const pills = computed(() =>
    Array.isArray(pillsData.value?.pills) ? pillsData.value.pills : [],
  );
  const loading = computed(
    () =>
      (homepageContentPending.value || placementPending.value || pillsPending.value) &&
      !placementData.value &&
      !homepageContent.value,
  );
  const error = computed(
    () =>
      homepageContentError.value?.message ||
      placementError.value?.message ||
      pillsError.value?.message ||
      null,
  );

  function bannerLinkLabel(block: HomepageRenderPageBannerBlock): string {
    const title = block.title?.trim();
    if (title) return title;
    const alt = block.alt?.trim();
    if (alt) return alt;
    const slug = block.pageSlug?.trim();
    if (slug) return `Go to ${slug}`;
    return 'Learn more';
  }

  function bannerImageAlt(block: HomepageRenderPageBannerBlock): string {
    const alt = block.alt?.trim();
    if (alt) return alt;
    const title = block.title?.trim();
    if (title) return title;
    return '';
  }

  function formatPillValue(pill: HomePill) {
    const mode = pill.value_mode || 'number';
    if (mode === 'percentage') return `${pill.value}%`;
    if (mode === 'agree_disagree') return `${pill.value}/${Number(pill.value_secondary || 0)}`;
    if (mode === 'graph_embed') return 'Graph';
    return String(pill.value);
  }

  const isMobileViewport = ref(false);

  const effectiveLayoutBlocks = computed(() =>
    orderLayoutBlocksForViewport(layoutBlocks.value, isMobileViewport.value),
  );

  const homepageRenderModel = computed(() =>
    buildHomepageRenderModel({
      videos: videos.value,
      layoutBlocks: effectiveLayoutBlocks.value,
      placement: placement.value,
    }),
  );

  /** First visible card is the mobile LCP candidate — load its thumbnail eagerly. */
  const lcpVideoId = computed(() => {
    for (const block of homepageRenderModel.value.blockItems) {
      if (block.type === 'top_video' && block.videos[0]?.id) return block.videos[0].id;
      if (block.type === 'featured_row' && block.videos[0]?.id) return block.videos[0].id;
      if (block.type === 'category' && block.categorySection?.visible[0]?.id) {
        return block.categorySection.visible[0].id;
      }
      if (block.type === 'category_with_side_mini') {
        const primaryVideo = block.primary.categorySection?.visible[0]?.id;
        if (primaryVideo) return primaryVideo;
      }
      if (block.type === 'split_horizontal' || block.type === 'split_vertical') {
        for (const child of block.children) {
          if (child.type === 'top_video' && child.videos[0]?.id) return child.videos[0].id;
          if (child.type === 'featured_row' && child.videos[0]?.id) return child.videos[0].id;
          if (child.categorySection?.visible[0]?.id) return child.categorySection.visible[0].id;
        }
      }
    }
    return videos.value[0]?.id ?? null;
  });

  function videoCardImageLoading(videoId: string): 'lazy' | 'eager' {
    return videoId === lcpVideoId.value ? 'eager' : 'lazy';
  }

  function videoCardImageFetchPriority(videoId: string): 'high' | 'auto' {
    return videoId === lcpVideoId.value ? 'high' : 'auto';
  }
  const bannerImageUrls = ref<Record<string, string>>({});

  const bannerImageIds = computed(() => {
    const ids = new Set<string>();
    for (const block of homepageRenderModel.value.blockItems) {
      if (block.type !== 'page_banner') continue;
      if (block.imageId) ids.add(block.imageId);
      if (block.mobileImageId) ids.add(block.mobileImageId);
    }
    return [...ids];
  });

  async function loadBannerImageUrls() {
    const apiBase = String(config.public.apiUrl || '').replace(/\/$/, '');
    const fetched = await fetchCmsMediaUrls(apiBase, bannerImageIds.value);
    bannerImageUrls.value = { ...bannerImageUrls.value, ...fetched };
  }

  function updateMobileViewport() {
    if (import.meta.client) isMobileViewport.value = window.innerWidth < 1024;
  }

  function collectHomepagePrefetchKeys(limit: number): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    const pushVideo = (video: { id?: string; slug?: string | null } | undefined) => {
      if (!video) return;
      const key = String(video.slug || video.id || '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    };
    const walk = (blocks: typeof homepageRenderModel.value.blockItems) => {
      for (const block of blocks) {
        if (keys.length >= limit) return;
        if (block.type === 'top_video' || block.type === 'featured_row') {
          for (const video of block.videos) {
            pushVideo(video);
            if (keys.length >= limit) return;
          }
        } else if (block.type === 'category') {
          for (const video of block.categorySection?.visible ?? []) {
            pushVideo(video);
            if (keys.length >= limit) return;
          }
        } else if (block.type === 'category_with_side_mini') {
          for (const video of block.primary.categorySection?.visible ?? []) {
            pushVideo(video);
            if (keys.length >= limit) return;
          }
          for (const video of block.sideMini.videos ?? []) {
            pushVideo(video);
            if (keys.length >= limit) return;
          }
        } else if (block.type === 'split_horizontal' || block.type === 'split_vertical') {
          for (const child of block.children) {
            if (keys.length >= limit) return;
            if (child.type === 'top_video' || child.type === 'featured_row') {
              for (const video of child.videos) {
                pushVideo(video);
                if (keys.length >= limit) return;
              }
            } else if (child.categorySection?.visible?.length) {
              for (const video of child.categorySection.visible) {
                pushVideo(video);
                if (keys.length >= limit) return;
              }
            } else {
              for (const video of child.videos ?? []) {
                pushVideo(video);
                if (keys.length >= limit) return;
              }
            }
          }
        }
      }
    };
    walk(homepageRenderModel.value.blockItems);
    if (keys.length < limit) {
      for (const video of videos.value) {
        pushVideo(video);
        if (keys.length >= limit) break;
      }
    }
    return keys;
  }

  function warmAboveFoldStartupPrefetch() {
    if (!import.meta.client) return;
    // Eagerly queue above-the-fold (+ more when logged in). Cards also observe
    // with a full-viewport rootMargin for anything the eager pass misses.
    const limit = isLoggedIn.value ? 12 : 4;
    enqueueVideoStartupPrefetchMany(collectHomepagePrefetchKeys(limit));
  }

  onMounted(() => {
    pwaBannerReady.value = true;
    updateMobileViewport();
    if (import.meta.client) window.addEventListener('resize', updateMobileViewport);
    warmAboveFoldStartupPrefetch();
  });

  onUnmounted(() => {
    if (import.meta.client) window.removeEventListener('resize', updateMobileViewport);
  });

  if (import.meta.client) {
    watch(
      bannerImageIds,
      () => {
        void loadBannerImageUrls();
      },
      { immediate: true },
    );
    watch(
      () => [homepageRenderModel.value.blockItems.length, videos.value.length, isLoggedIn.value],
      () => {
        warmAboveFoldStartupPrefetch();
      },
    );
  }
</script>
