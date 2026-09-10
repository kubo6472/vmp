<template>
  <NuxtLink
    ref="linkEl"
    :to="`/watch/${video.slug || video.id}`"
    class="group block"
    :class="linkClass"
    :data-vmp-prefetch-key="prefetchKey"
    @pointerenter="onPrefetchIntent"
  >
    <div
      class="relative aspect-video rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-800"
      :class="mediaClass"
    >
      <img
        v-if="video.thumbnail_url"
        :src="cardThumbnailSrc"
        :srcset="cardThumbnailSrcset"
        :sizes="cardThumbnailSizes"
        :alt="video.title"
        :loading="props.imageLoading"
        :fetchpriority="props.imageFetchPriority"
        width="640"
        height="360"
        decoding="async"
        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
      >
      <div
        class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all"
      ></div>

      <!-- Duration Badge -->
      <div
        class="absolute bottom-2 right-2 bg-black bg-opacity-80 text-white dark:text-white text-xs px-2 py-1 rounded"
      >
        {{ displayDurationSeconds ? formatDuration(displayDurationSeconds) : '--' }}
      </div>

      <!-- Premium Badge — show when preview is explicitly shorter than full, or when
      full duration is unknown (0) but a non-zero preview_duration is set -->
      <div
        v-if="displayDurationSeconds > 0 ? video.preview_duration < displayDurationSeconds : video.preview_duration > 0"
        class="absolute top-2 left-2 bg-yellow-500 text-black text-xs font-semibold px-2 py-1 rounded"
      >
        {{ premiumLabel }}
      </div>
    </div>
    <div class="min-w-0" :class="contentClass">
      <h3
        class="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400"
        :class="[titleClass, { 'line-clamp-2': props.clampTitle }]"
      >
        {{ video.title }}
      </h3>
      <p
        v-if="props.showRelativeTimestamp && relativeUploadTime"
        class="text-xs text-gray-500 dark:text-gray-400"
      >
        {{ relativeUploadTime }}
      </p>
      <p v-if="props.showDescription" class="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
        {{ video.description }}
      </p>
    </div>
  </NuxtLink>
</template>

<script setup lang="ts">
  import { computed, inject, onBeforeUnmount, onMounted, type Ref, ref } from 'vue';
  import { useThumbnail } from '~/composables/useThumbnail';
  import strings from '~/utils/strings';

  interface Video {
    id: string;
    title: string;
    description: string;
    thumbnail_url: string;
    /**
     * Legacy snake_case duration from older API responses.
     */
    full_duration?: number;
    /**
     * Newer camelCase duration used by video-access and, in some cases, list endpoints.
     */
    fullDuration?: number;
    preview_duration: number;
    upload_date: string;
    slug?: string | null;
  }

  const props = withDefaults(
    defineProps<{
      video: Video;
      layout?: 'default' | 'horizontal';
      titleScale?: 'default' | 'hero';
      showDescription?: boolean;
      showRelativeTimestamp?: boolean;
      clampTitle?: boolean;
      imageLoading?: 'lazy' | 'eager';
      imageFetchPriority?: 'high' | 'low' | 'auto';
      /** When false, skip catalog HLS warmup for this card. */
      startupPrefetch?: boolean;
    }>(),
    {
      layout: 'default',
      titleScale: 'default',
      showDescription: true,
      showRelativeTimestamp: false,
      clampTitle: true,
      imageLoading: 'lazy',
      imageFetchPriority: 'auto',
      startupPrefetch: true,
    },
  );

  const prefetchKey = computed(() => String(props.video.slug || props.video.id || ''));
  const linkEl = ref<HTMLElement | null>(null);
  const enqueueStartupPrefetch = inject<((videoKey: string) => void) | null>(
    'enqueueVideoStartupPrefetch',
    null,
  );
  const startupPrefetchMode = inject<Ref<'visible' | 'hover'> | null>(
    'videoStartupPrefetchMode',
    null,
  );
  let intersectionObserver: IntersectionObserver | undefined;

  const onPrefetchIntent = () => {
    if (!props.startupPrefetch) return;
    if (startupPrefetchMode?.value === 'hover') {
      enqueueStartupPrefetch?.(prefetchKey.value);
    }
  };

  const { sizedUrl } = useThumbnail(computed(() => props.video.thumbnail_url));
  const cardThumbnailSrc = computed(() => sizedUrl('small') ?? sizedUrl('medium'));
  const cardThumbnailSrcset = computed(() => {
    const small = sizedUrl('small');
    const medium = sizedUrl('medium');
    if (!small && !medium) return undefined;
    const parts: string[] = [];
    if (small) parts.push(`${small} 320w`);
    if (medium) parts.push(`${medium} 640w`);
    return parts.length ? parts.join(', ') : undefined;
  });
  const cardThumbnailSizes = computed(() =>
    props.layout === 'horizontal'
      ? '(max-width: 767px) 100vw, 58vw'
      : '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw',
  );
  const isHorizontal = computed(() => props.layout === 'horizontal');
  const now = ref(Date.now());
  let nowInterval: ReturnType<typeof setInterval> | undefined;

  const linkClass = computed(() =>
    isHorizontal.value ? 'md:grid md:grid-cols-[58%_42%] md:gap-4 md:items-center' : '',
  );
  const mediaClass = computed(() => (isHorizontal.value ? 'mb-2 md:mb-0' : 'mb-2'));
  const contentClass = computed(() => (isHorizontal.value ? 'space-y-2' : ''));
  const titleClass = computed(() => {
    if (!isHorizontal.value) return 'mb-1';
    return props.titleScale === 'hero'
      ? 'text-xl md:text-3xl leading-tight'
      : 'text-base leading-snug';
  });
  const relativeUploadTime = computed(() => {
    const sourceDate = props.video.upload_date;
    if (!sourceDate) return '';
    const uploadedAt = new Date(sourceDate).getTime();
    if (Number.isNaN(uploadedAt)) return '';
    const diffMs = now.value - uploadedAt;
    if (diffMs < 0) return '';

    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;

    const years = Math.floor(months / 12);
    return `${years}y ago`;
  });

  onMounted(() => {
    nowInterval = setInterval(() => {
      now.value = Date.now();
    }, 30_000);

    if (
      !props.startupPrefetch ||
      !enqueueStartupPrefetch ||
      !prefetchKey.value ||
      startupPrefetchMode?.value !== 'visible'
    ) {
      return;
    }

    const el = linkEl.value as { $el?: Element } | Element | null as
      | { $el?: Element }
      | Element
      | null;
    const node =
      el && '$el' in (el as object) ? (el as { $el?: Element }).$el : (el as Element | null);
    if (!node || typeof IntersectionObserver === 'undefined') {
      enqueueStartupPrefetch(prefetchKey.value);
      return;
    }
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            enqueueStartupPrefetch(prefetchKey.value);
            intersectionObserver?.disconnect();
            intersectionObserver = undefined;
          }
        }
      },
      { rootMargin: '240px 0px', threshold: 0.01 },
    );
    intersectionObserver.observe(node);
  });

  onBeforeUnmount(() => {
    if (nowInterval) clearInterval(nowInterval);
    intersectionObserver?.disconnect();
    intersectionObserver = undefined;
  });

  // Prefer camelCase `fullDuration` when present, with a fallback to legacy `full_duration`.
  const displayDurationSeconds = computed(
    () => props.video.fullDuration ?? props.video.full_duration ?? 0,
  );

  const premiumLabel = strings.premiumBadge;

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
</script>
