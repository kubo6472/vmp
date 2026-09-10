<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header>
        <NuxtLink
          to="/"
          class="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >{{ strings.backToHomepage }}</NuxtLink
        >
        <h1 class="text-3xl font-bold text-gray-900 dark:text-white mt-2">{{ categoryName }}</h1>
        <p class="text-gray-600 dark:text-gray-400">{{ strings.categoryVideosCount(total) }}</p>
      </header>

      <div v-if="loading" class="text-center py-16">
        <div
          class="inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"
        ></div>
      </div>
      <div
        v-else-if="error"
        class="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-4 text-red-700 dark:text-red-200"
      >
        {{ error }}
      </div>
      <div
        v-else-if="videos.length === 0"
        class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-gray-600 dark:text-gray-300"
      >
        {{ strings.categoryEmpty }}
      </div>
      <div v-else class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          <VideoCard v-for="video in videos" :key="video.id" :video="video" />
        </div>
        <div class="flex items-center justify-center gap-3">
          <button
            class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
            :disabled="page <= 1 || loadingMore"
            @click="loadPage(page - 1)"
          >
            {{ strings.categoryPrevious }}
          </button>
          <span class="text-sm text-gray-600 dark:text-gray-400"
            >{{ strings.categoryPage(page) }}</span
          >
          <button
            class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
            :disabled="!hasMore || loadingMore"
            @click="loadPage(page + 1)"
          >
            {{ strings.categoryNext }}
          </button>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
  import { useVideoStartupPrefetch } from '~/composables/useVideoStartupPrefetch';
  import strings from '~/utils/strings';

  const route = useRoute();
  const config = useRuntimeConfig();
  const { isLoggedIn, authHeader } = useAuth();

  const { enqueueMany } = useVideoStartupPrefetch({
    apiUrl: String(config.public.apiUrl),
    authHeaders: () => authHeader(),
    isLoggedIn,
    segmentCount: 3,
  });

  const categorySlug = computed(() => String(route.params.slug || ''));
  const page = ref(1);

  watch(categorySlug, () => {
    page.value = 1;
  });

  type CategoryVideosResponse = {
    category?: { name?: string };
    videos?: any[];
    pagination?: { total?: number; hasMore?: boolean; page?: number };
  };

  const {
    data: categoryData,
    pending,
    error: fetchError,
  } = await useAsyncData(
    () => `category-videos-${categorySlug.value}-${page.value}`,
    () =>
      $fetch<CategoryVideosResponse>(
        `${config.public.apiUrl}/api/categories/${encodeURIComponent(categorySlug.value)}/videos?page=${page.value}&pageSize=24`,
      ),
    { watch: [categorySlug, page] },
  );

  const videos = computed(() => categoryData.value?.videos ?? []);
  const categoryName = computed(
    () => categoryData.value?.category?.name || strings.categoryDefaultName,
  );
  const total = computed(() => Number(categoryData.value?.pagination?.total ?? 0));
  const hasMore = computed(() => Boolean(categoryData.value?.pagination?.hasMore));
  const loading = computed(() => pending.value && !categoryData.value);
  const loadingMore = computed(() => pending.value && Boolean(categoryData.value));
  const error = computed(() => fetchError.value?.message ?? null);

  usePageSeo(
    computed(() => {
      const name = categoryName.value;
      const count = total.value;
      return {
        title: name,
        description:
          count > 0
            ? strings.categorySeoVideosIn(count, name)
            : strings.categorySeoVideosInName(name),
      };
    }),
  );

  const loadPage = (nextPage: number) => {
    if (nextPage < 1 || nextPage === page.value) return;
    page.value = nextPage;
  };

  function warmCategoryStartupPrefetch() {
    if (!import.meta.client) return;
    const limit = isLoggedIn.value ? 12 : 4;
    const keys: string[] = [];
    for (const video of videos.value) {
      const key = String(video?.slug || video?.id || '');
      if (!key) continue;
      keys.push(key);
      if (keys.length >= limit) break;
    }
    enqueueMany(keys);
  }

  if (import.meta.client) {
    watch(
      () => [videos.value.length, page.value, isLoggedIn.value, categorySlug.value],
      () => {
        warmCategoryStartupPrefetch();
      },
      { immediate: true },
    );
  }
</script>
