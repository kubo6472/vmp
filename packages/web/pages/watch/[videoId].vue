<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <PremiumOverlay
      :show="showPremiumOverlay && !isFullPublicPreview"
      :video-id="videoId"
      @close="showPremiumOverlay = false"
    />

    <div class="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <!-- Loading State -->
      <div v-if="loading" class="flex items-center justify-center min-h-[60vh]">
        <div class="text-center">
          <div
            class="inline-block w-12 h-12 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin mb-4"
          ></div>
          <p class="text-gray-600 dark:text-gray-400">{{ strings.loadingVideo }}</p>
        </div>
      </div>

      <!-- Rate Limit State -->
      <div v-else-if="rateLimited" class="max-w-4xl mx-auto">
        <div
          class="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-6"
        >
          <div class="flex items-start space-x-4">
            <div
              class="flex-shrink-0 w-10 h-10 bg-amber-100 dark:bg-amber-900 rounded-full flex items-center justify-center"
            >
              <svg
                class="w-5 h-5 text-amber-600 dark:text-amber-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 102 0V6zm-1 8a1 1 0 100-2 1 1 0 000 2z"
                  clip-rule="evenodd"
                />
              </svg>
            </div>
            <div class="flex-1">
              <h3 class="text-lg font-semibold text-amber-900 dark:text-amber-200 mb-1">
                {{ strings.rateLimitTitle }}
              </h3>
              <p class="text-amber-800 dark:text-amber-300 mb-4">
                {{ strings.rateLimitMessage(rateLimitCurrent, rateLimitLimit) }}
              </p>
              <div class="flex items-center space-x-3">
                <button
                  type="button"
                  class="inline-flex items-center px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg transition-colors"
                  @click="handleRateLimitSignIn"
                >
                  {{ strings.signIn }}
                </button>
                <NuxtLink to="/" class="text-amber-700 dark:text-amber-400 hover:underline text-sm">
                  {{ strings.backToHomepage }}
                </NuxtLink>
              </div>
              <p v-if="rateLimitRetryAfter" class="mt-3 text-xs text-amber-600 dark:text-amber-500">
                {{ strings.rateLimitWait(formatRetryAfter(rateLimitRetryAfter)) }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Video Not Found -->
      <div v-else-if="showVideoNotFound" class="max-w-6xl mx-auto space-y-8">
        <div
          class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-8 text-center"
        >
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            {{ strings.videoNotFoundTitle }}
          </h1>
          <p class="text-gray-600 dark:text-gray-400 mb-6">{{ strings.videoNotFoundMessage }}</p>
          <NuxtLink
            to="/"
            class="inline-flex items-center px-4 py-2 text-sm font-semibold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            {{ strings.backToHomepage }}
          </NuxtLink>
        </div>

        <div v-if="recommendations.length" class="space-y-4">
          <h2 class="text-lg font-bold text-gray-900 dark:text-white px-2">
            {{ strings.videoNotFoundSuggestions }}
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <VideoCard
              v-for="rec in recommendations"
              :key="rec.id"
              :video="rec"
              :show-description="true"
              :show-relative-timestamp="true"
            />
          </div>
        </div>
      </div>

      <!-- Playback temporarily unavailable -->
      <div v-else-if="playbackUnavailable" class="max-w-6xl mx-auto space-y-8">
        <div
          class="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-8"
        >
          <div class="flex items-start space-x-4">
            <div
              class="flex-shrink-0 w-10 h-10 bg-amber-100 dark:bg-amber-900 rounded-full flex items-center justify-center"
            >
              <svg
                class="w-5 h-5 text-amber-600 dark:text-amber-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                />
              </svg>
            </div>
            <div class="flex-1">
              <h1 class="text-2xl font-bold text-amber-900 dark:text-amber-100 mb-2">
                {{ strings.playbackUnavailableTitle }}
              </h1>
              <p class="text-amber-800 dark:text-amber-300 mb-6">
                {{ strings.playbackUnavailableMessage }}
              </p>
              <NuxtLink
                to="/"
                class="inline-flex items-center px-4 py-2 text-sm font-semibold text-amber-900 dark:text-amber-100 bg-white dark:bg-amber-950 border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors"
              >
                {{ strings.backToHomepage }}
              </NuxtLink>
            </div>
          </div>
        </div>

        <div v-if="recommendations.length" class="space-y-4">
          <h2 class="text-lg font-bold text-gray-900 dark:text-white px-2">
            {{ strings.playbackUnavailableSuggestions }}
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <VideoCard
              v-for="rec in recommendations"
              :key="rec.id"
              :video="rec"
              :show-description="true"
              :show-relative-timestamp="true"
            />
          </div>
        </div>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="max-w-4xl mx-auto">
        <div
          class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6"
        >
          <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">
            {{ strings.error }}
          </h3>
          <p class="text-red-700 dark:text-red-300">{{ error }}</p>
          <NuxtLink
            to="/"
            class="inline-block mt-4 text-blue-600 dark:text-blue-400 hover:underline"
          >
            {{ strings.backToHomepage }}
          </NuxtLink>
        </div>
      </div>

      <!-- Main Content -->
      <div v-else-if="videoData" class="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
        <!-- Left Column: Player + Info -->
        <div class="space-y-4">
          <!-- Preview banner (above player, not overlaying video) -->
          <div
            v-if="!videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview"
            class="-mx-4 sm:mx-0 bg-gradient-to-r from-yellow-500 to-yellow-600 text-black px-4 py-2 flex items-center justify-between text-sm sm:text-base sm:rounded-t-lg"
          >
            <div class="flex items-center space-x-2 min-w-0">
              <svg class="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                  clip-rule="evenodd"
                />
              </svg>
              <span class="font-semibold truncate">{{ strings.previewMode }}</span>
            </div>
            <span class="text-xs sm:text-sm shrink-0 ml-3">{{ strings.upgradeToWatch }}</span>
          </div>

          <!-- Player Container -->
          <div
            class="relative bg-black overflow-hidden -mx-4 sm:mx-0"
            :class="[
              !videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview
                ? 'sm:rounded-b-lg'
                : 'sm:rounded-lg',
            ]"
          >
            <!-- Route transition overlay (recommendation click — avoid full-page reload UX) -->
            <div
              v-if="isNavigatingToAnotherVideo"
              class="absolute inset-0 z-30 flex items-center justify-center bg-black/60 pointer-events-none"
              role="status"
              aria-live="polite"
              :aria-label="strings.loadingVideo"
            >
              <div
                class="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin"
                aria-hidden="true"
              ></div>
            </div>

            <!-- Buffering Spinner -->
            <div
              v-if="buffering"
              class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none"
              role="status"
              aria-live="polite"
              :aria-label="strings.videoBuffering"
            >
              <div
                class="w-14 h-14 border-4 border-white/20 border-t-white rounded-full animate-spin"
                aria-hidden="true"
              ></div>
              <span class="sr-only">{{ strings.videoBuffering }}</span>
            </div>

            <button
              v-if="autoplayMuting && !autoplayBlocked"
              type="button"
              class="absolute top-3 right-3 z-20 inline-flex items-center gap-2 rounded-full bg-black/70 border border-white/30 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-100 shadow-lg"
              @click="handleUnmuteBannerClick"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path
                  d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
                />
              </svg>
              <span class="text-white dark:text-gray-100">{{ strings.offlineTapToUnmute }}</span>
            </button>

            <button
              v-if="autoplayBlocked"
              type="button"
              class="absolute inset-0 z-20 flex items-center justify-center"
              :aria-label="strings.playVideo"
              @click="handleAutoplayOverlayClick"
            >
              <span
                class="w-20 h-20 rounded-full bg-black/70 border-2 border-white/70 text-white flex items-center justify-center shadow-xl"
              >
                <svg
                  class="w-10 h-10 ml-1"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </button>

            <!-- Video Player -->
            <media-controller
              v-if="!videoData.video.isLivestream"
              id="watch-media-controller"
              ref="mediaControllerRef"
              class="watch-media-controller group/controls block w-full aspect-video relative"
              :class="{ 'watch-video-fill': videoFillMode === 'cover' }"
              @click.capture="handleUserPlaybackInteraction"
              @pointerdown="handleUserPlaybackInteraction"
              @touchstart.passive="handlePlayerTouchStart"
              @touchmove.passive="handlePlayerTouchMove"
              @touchend.passive="handlePlayerTouchEnd"
              @mediaplayrequest.capture="handleMediaPlayRequest"
              @mediapauserequest.capture="handleMediaPauseRequest"
            >
              <videojs-video
                ref="videoElement"
                slot="media"
                class="watch-media-element block w-full h-full"
                playsinline
                preload="auto"
                @timeupdate="handleTimeUpdate"
                @seeking="handleSeeking"
                @seeked="handleSeeked"
                @play="handleVideoPlay"
                @pause="handleVideoPause"
              ></videojs-video>

              <media-loading-indicator slot="centered-chrome"></media-loading-indicator>

              <media-playback-rate-menu
                hidden
                anchor="auto"
                class="watch-playback-rate-menu"
                rates="0.5 0.75 1 1.25 1.5 2"
              >
                <span slot="header">{{ strings.playbackSpeed }}</span>
              </media-playback-rate-menu>

              <div
                v-show="mobileSettingsOpen"
                ref="mobileSettingsMenuRef"
                class="watch-mobile-settings-menu sm:hidden"
                role="menu"
                :aria-label="strings.playbackSpeed"
                @click.stop
              >
                <p class="watch-mobile-settings-title">{{ strings.playbackSpeed }}</p>
                <button
                  v-for="option in playbackRateOptions"
                  :key="option.value"
                  type="button"
                  class="watch-mobile-settings-item"
                  role="menuitemradio"
                  :aria-checked="isPlaybackRateSelected(option.value)"
                  @click="handleMobilePlaybackRate(option.value)"
                >
                  <span>{{ option.label }}</span>
                  <svg
                    v-if="isPlaybackRateSelected(option.value)"
                    class="w-4 h-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </div>

              <!-- Custom Control Bar — stacked: seekbar on top, buttons below -->
              <div class="watch-controls-container">
                <!-- Seekbar row — full width, separate from buttons -->
                <div class="watch-seekbar-row">
                  <div class="watch-seekbar-wrap">
                    <div
                      class="relative w-full h-1 group-hover/controls:h-1.5 rounded-full pointer-events-none transition-all"
                    >
                      <div class="absolute inset-0 rounded-full bg-white/25"></div>
                      <div
                        v-if="!videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview"
                        class="absolute inset-y-0 rounded-r-full bg-white/5"
                        :style="{ left: previewPercentage + '%' }"
                      ></div>
                      <div
                        class="absolute inset-y-0 left-0 rounded-full bg-blue-500"
                        :style="{ width: progressPercentage + '%' }"
                      ></div>
                      <div
                        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-md opacity-0 group-hover/controls:opacity-100 transition-opacity"
                        :style="{ left: progressPercentage + '%' }"
                      ></div>
                      <div
                        v-if="!videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview"
                        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-yellow-400 border-2 border-black rounded-full flex items-center justify-center shadow-[0_0_0_3px_rgba(250,204,21,0.3)] z-10"
                        :style="{ left: previewPercentage + '%' }"
                      >
                        <svg class="w-2 h-2 text-black" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fill-rule="evenodd"
                            d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                            clip-rule="evenodd"
                          />
                        </svg>
                      </div>
                    </div>
                    <input
                      type="range"
                      class="watch-seekbar-input absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      :aria-label="strings.seekTimeline"
                      :min="0"
                      :max="effectiveFullDuration"
                      :step="0.1"
                      :value="currentTime"
                      :aria-valuemin="0"
                      :aria-valuemax="effectiveFullDuration"
                      :aria-valuenow="currentTime"
                      @input.capture="handleUserPlaybackInteraction"
                      @input="handleSeekbarInput"
                      @keydown.capture="handleUserPlaybackInteraction"
                    >
                  </div>
                </div>

                <!-- Button row -->
                <media-control-bar class="watch-media-control-bar" noautohide>
                  <media-play-button></media-play-button>
                  <media-seek-backward-button
                    class="hidden sm:inline-flex"
                    seek-offset="10"
                  ></media-seek-backward-button>
                  <media-seek-forward-button
                    class="hidden sm:inline-flex"
                    seek-offset="10"
                  ></media-seek-forward-button>
                  <media-time-display show-duration></media-time-display>
                  <span class="flex-1"></span>
                  <media-mute-button></media-mute-button>
                  <media-volume-range class="hidden sm:inline-flex"></media-volume-range>
                  <media-cast-button class="watch-cast-button"></media-cast-button>
                  <button
                    v-if="airplayAvailable"
                    type="button"
                    class="watch-icon-button watch-airplay-button"
                    :aria-label="strings.startAirPlay"
                    @click.stop="handleAirplayButtonClick"
                  >
                    <svg viewBox="0 0 26 24" fill="currentColor" aria-hidden="true">
                      <path
                        d="M22.13 3H3.87a.87.87 0 00-.87.87v13.26c0 .48.39.87.87.87h3.4L9 16H5V5h16v11h-4l1.72 2h3.4c.48 0 .87-.39.87-.87V3.87A.87.87 0 0022.13 3zm-8.75 11.44a.5.5 0 00-.76 0l-4.91 5.73a.5.5 0 00.38.83h9.82a.5.5 0 00.38-.83l-4.91-5.73z"
                      />
                    </svg>
                  </button>
                  <media-playback-rate-menu-button
                    class="watch-playback-rate-menu-button hidden sm:inline-flex"
                  ></media-playback-rate-menu-button>
                  <OfflineDownloadButton
                    v-if="videoData.hasAccess"
                    :video-id="videoId"
                    :video-title="videoData.video.title"
                  />
                  <button
                    type="button"
                    class="watch-icon-button watch-settings-menu-button sm:hidden"
                    aria-haspopup="menu"
                    :aria-expanded="mobileSettingsOpen"
                    :aria-label="strings.settings"
                    @click.stop="toggleMobileSettings"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path
                        d="M4.5 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm7.5 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm7.5 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="watch-icon-button watch-fullscreen-button"
                    :aria-label="isPlayerFullscreen ? strings.exitFullscreen : strings.enterFullscreen"
                    @click.stop="handleFullscreenButtonClick"
                  >
                    <svg
                      v-if="isPlayerFullscreen"
                      viewBox="0 0 26 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        d="M18.5 6.5V3H16v6h6V6.5h-3.5zM16 21h2.5v-3.5H22V15h-6v6zM4 17.5h3.5V21H10v-6H4v2.5zm3.5-11H4V9h6V3H7.5v3.5z"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 26 24" fill="currentColor" aria-hidden="true">
                      <path
                        d="M16 3v2.5h3.5V9H22V3h-6zM4 9h2.5V5.5H10V3H4v6zm15.5 9.5H16V21h6v-6h-2.5v3.5zM6.5 15H4v6h6v-2.5H6.5V15z"
                      />
                    </svg>
                  </button>
                </media-control-bar>
              </div>
            </media-controller>
            <div
              v-else
              ref="liveMoqShellRef"
              class="watch-live-moq-shell group/livemoq relative block w-full aspect-video bg-black"
            >
              <canvas ref="liveCanvas" class="block w-full h-full" />
              <div v-if="hasLivestreamMoqSource" class="watch-live-moq-controls-container">
                <media-control-bar class="watch-live-moq-control-bar" noautohide>
                  <button
                    type="button"
                    class="watch-live-moq-icon-btn"
                    :aria-label="liveMoqIsPaused ? strings.playVideo : strings.pauseVideo"
                    @click="handleLiveMoqPlayPause"
                  >
                    <svg
                      v-if="liveMoqIsPaused"
                      class="w-7 h-7"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    <svg
                      v-else
                      class="w-7 h-7"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="watch-live-moq-live-edge-btn"
                    :aria-label="strings.goToLive"
                    @click="liveMoqGoLive"
                  >
                    <span
                      class="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0"
                      aria-hidden="true"
                    ></span>
                    <span>{{ strings.live }}</span>
                  </button>
                  <span class="flex-1 min-w-2"></span>
                  <button
                    type="button"
                    class="watch-live-moq-icon-btn"
                    :aria-label="liveMoqIsMuted ? strings.unmute : strings.mute"
                    @click="liveMoqToggleMute"
                  >
                    <svg
                      v-if="liveMoqIsMuted"
                      class="w-6 h-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
                      />
                    </svg>
                    <svg
                      v-else
                      class="w-6 h-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
                      />
                    </svg>
                  </button>
                  <input
                    type="range"
                    class="watch-live-moq-volume"
                    min="0"
                    max="1"
                    step="0.05"
                    :value="liveMoqVolume"
                    :aria-label="strings.volume"
                    @input="onLiveMoqVolumeInput"
                  >
                  <button
                    type="button"
                    class="watch-live-moq-icon-btn"
                    :aria-label="strings.fullscreen"
                    @click="liveMoqToggleFullscreen"
                  >
                    <svg class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path
                        d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
                      />
                    </svg>
                  </button>
                </media-control-bar>
              </div>
            </div>
            <div
              v-if="videoData.video.isLivestream && !hasAnyLivestreamPlaybackSource"
              class="absolute inset-0 z-10 bg-black/85 flex items-center justify-center px-6 text-center"
            >
              <div>
                <p class="text-base font-semibold text-white">
                  {{ strings.livestreamUnavailable }}
                </p>
                <p class="mt-1 text-sm text-gray-300">{{ strings.livestreamUnavailableDetail }}</p>
              </div>
            </div>
          </div>

          <!-- Video Info -->
          <div
            class="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800"
          >
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              {{ videoData.video.title }}
            </h1>

            <p
              v-if="playbackResumeHint"
              class="text-sm text-gray-600 dark:text-gray-400 mb-3"
            >
              {{ playbackResumeHint }}
            </p>

            <p
              v-if="resumeAppliedNotice"
              class="mb-3 inline-flex items-center gap-2 rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 px-3 py-2 text-sm text-blue-900 dark:text-blue-200"
            >
              {{ resumeAppliedNotice }}
            </p>

            <div
              v-if="playingOffline"
              class="mb-4 inline-flex items-center gap-2 rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 px-3 py-2 text-sm text-blue-900 dark:text-blue-200"
            >
              <svg
                class="w-4 h-4 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"
                />
              </svg>
              <span>{{ strings.offlinePlaybackBadge }}</span>
            </div>

            <div class="flex items-center space-x-4 text-sm text-gray-600 dark:text-gray-400 mb-4">
              <span
                v-if="videoData.video.isLivestream"
                class="inline-flex items-center gap-2 rounded px-2 py-0.5 text-rose-600 dark:text-rose-400 font-semibold"
              >
                <span
                  class="inline-block w-2.5 h-3 rounded-sm bg-rose-500 shrink-0"
                  aria-hidden="true"
                ></span>
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0"
                    aria-hidden="true"
                  ></span>
                  <span>{{ strings.live }}</span>
                </span>
              </span>
              <template v-else>
                <span class="flex items-center space-x-1">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span
                    >{{ effectiveFullDuration ? formatDuration(effectiveFullDuration) : '--' }}</span
                  >
                </span>

                <span
                  v-if="videoData.hasAccess"
                  class="flex items-center space-x-1 text-yellow-600 dark:text-yellow-400 font-semibold"
                >
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"
                    />
                  </svg>
                  <span>{{ strings.premiumAccess }}</span>
                </span>

                <span
                  v-else-if="isFullPublicPreview"
                  class="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 font-medium"
                >
                  <span>{{ strings.freeToWatch }}</span>
                </span>
                <span v-else class="flex items-center space-x-1">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fill-rule="evenodd"
                      d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                  <span
                    >{{ strings.previewOnly(videoData.video.previewDuration != null ? formatDuration(videoData.video.previewDuration) : '--') }}</span
                  >
                </span>
              </template>
            </div>

            <div class="relative">
              <div
                id="video-description"
                ref="descriptionRef"
                class="text-gray-700 dark:text-gray-300 leading-relaxed prose prose-sm dark:prose-invert max-w-none transition-[max-height] duration-200"
                :class="descriptionExpanded ? '' : 'watch-description-collapsed'"
                v-html="videoDescriptionHtml"
              ></div>
              <div
                v-if="!descriptionExpanded && descriptionClamped"
                class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white dark:from-gray-900 to-transparent"
                aria-hidden="true"
              ></div>
              <div v-if="descriptionClamped" class="flex justify-center pt-3">
                <button
                  type="button"
                  class="px-5 py-1.5 text-sm font-semibold tracking-wide uppercase rounded-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
                  :aria-expanded="descriptionExpanded"
                  aria-controls="video-description"
                  @click="descriptionExpanded = !descriptionExpanded"
                >
                  {{ descriptionExpanded ? strings.readLess : strings.readMore }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column: Recommendations -->
        <div class="space-y-4">
          <h2 class="text-lg font-bold text-gray-900 dark:text-white px-2">{{ strings.upNext }}</h2>

          <div class="space-y-3">
            <NuxtLink
              v-for="rec in recommendations"
              :key="rec.id"
              :to="recommendationWatchPath(rec)"
              :prefetch="false"
              class="block bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden hover:border-gray-300 dark:hover:border-gray-700 transition-colors"
            >
              <div class="flex space-x-3 p-3">
                <div
                  class="relative w-40 h-24 flex-shrink-0 bg-gray-200 dark:bg-gray-800 rounded overflow-hidden"
                >
                  <img
                    v-if="rec.thumbnail_url"
                    :src="sizeUrl(rec.thumbnail_url, 'small')"
                    :alt="rec.title"
                    class="w-full h-full object-cover"
                  >
                  <div
                    v-if="isLiveRecommendation(rec)"
                    class="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                  >
                    <span
                      class="inline-block w-1.5 h-2 rounded-sm bg-rose-500 shrink-0"
                      aria-hidden="true"
                    ></span>
                    <span class="inline-flex items-center gap-0.5 font-semibold">
                      <span
                        class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0"
                        aria-hidden="true"
                      ></span>
                      Live
                    </span>
                  </div>
                  <div
                    v-else
                    class="absolute bottom-1 right-1 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5 rounded"
                  >
                    {{ rec.full_duration ? formatDuration(rec.full_duration) : '--' }}
                  </div>
                  <div
                    v-if="!isLiveRecommendation(rec) && (rec.full_duration > 0 ? rec.preview_duration < rec.full_duration : rec.preview_duration > 0)"
                    class="absolute top-1 left-1 bg-yellow-500 text-black text-xs font-semibold px-1.5 py-0.5 rounded"
                  >
                    PRO
                  </div>
                </div>

                <div class="flex-1 min-w-0">
                  <h3 class="font-semibold text-sm text-gray-900 dark:text-white line-clamp-2 mb-1">
                    {{ rec.title }}
                  </h3>
                  <p class="text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
                    {{ rec.description }}
                  </p>
                </div>
              </div>
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { canonicalWatchToken } from '@vmp/shared';
  import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
  import { useRoute } from 'vue-router';
  import { setResponseStatus, useRuntimeConfig } from '#app';
  import 'media-chrome';
  import 'media-chrome/menu';
  import { resolvePlaylistDuration } from '~/composables/useHlsDuration';
  import {
    isLiveRecommendation,
    useMoqLivePlayerControls,
  } from '~/composables/useMoqLivePlayerControls';
  import {
    shouldResumePlaybackPosition,
    usePlaybackPosition,
  } from '~/composables/usePlaybackPosition';
  import { PLAYBACK_RATE_OPTIONS, usePlaybackRate } from '~/composables/usePlaybackRate';
  import { usePushAttribution } from '~/composables/usePushAttribution';
  import { sizeUrl } from '~/composables/useThumbnail';
  import { renderMarkdownToHtml } from '~/utils/markdown';
  import { claimActivePlayerVideoIdForFlush, assignActivePlayerVideoIdIfCurrent } from '~/utils/playbackRouteFlush';
  import { trackOfflineEvent } from '~/utils/offline/analytics';
  import {
    checkPlaylistAvailability,
    isPlaybackUnavailableCode,
    isPlaybackUnavailableError,
    PlaybackUnavailableError,
  } from '~/utils/playlistAvailability';
  import { captureBrowserException } from '~/utils/posthogBrowserClient';
  import strings from '~/utils/strings';
  import { routeParamMatchesVideoMeta } from '~/utils/watchRouteMeta';

  const route = useRoute();
  const config = useRuntimeConfig();

  type VideoMetaResponse = {
    id: string;
    slug: string | null;
    title: string;
    description: string;
    thumbnail_url: string | null;
    canonicalWatchPath?: string;
  };

  type VideoMetaAsyncValue = {
    meta: VideoMetaResponse | null;
    notFound: boolean;
  };

  const emptyVideoMeta = (): VideoMetaAsyncValue => ({ meta: null, notFound: false });

  const videoIdParam = computed(() => String(route.params.videoId ?? '').trim());

  const { data: videoMetaState, pending: videoMetaPending } = await useAsyncData(
    () => `video-meta-${videoIdParam.value}`,
    async () => {
      if (!videoIdParam.value) return emptyVideoMeta();
      try {
        const meta = await $fetch<VideoMetaResponse>(
          `${config.public.apiUrl}/api/videos/${encodeURIComponent(videoIdParam.value)}/meta`,
        );
        return { meta, notFound: false };
      } catch (error: any) {
        const status = error?.statusCode ?? error?.response?.status ?? error?.status;
        if (status === 404) return { meta: null, notFound: true };
        return emptyVideoMeta();
      }
    },
    { watch: [videoIdParam] },
  );

  const videoMeta = computed(() => videoMetaState.value?.meta ?? null);
  const videoNotFound = computed(() => videoMetaState.value?.notFound === true);
  const accessNotFound = ref(false);
  const showVideoNotFound = computed(() => videoNotFound.value || accessNotFound.value);

  function markVideoNotFoundResponse() {
    accessNotFound.value = true;
    if (import.meta.server) {
      setResponseStatus(404);
    }
  }

  const canonicalWatchPath = computed(() => {
    if (!videoMeta.value) return null;
    return (
      videoMeta.value.canonicalWatchPath ??
      `/watch/${encodeURIComponent(canonicalWatchToken(videoMeta.value))}`
    );
  });

  if (videoMeta.value && canonicalWatchPath.value) {
    const canonicalToken = decodeURIComponent(canonicalWatchPath.value.replace(/^\/watch\//, ''));
    if (videoIdParam.value && videoIdParam.value !== canonicalToken) {
      await navigateTo(canonicalWatchPath.value, { redirectCode: 301 });
    }
  }

  usePageSeo(
    computed(() => ({
      title: videoMeta.value?.title,
      description: videoMeta.value?.description,
      image: videoMeta.value?.thumbnail_url,
      ogType: 'video.other' as const,
    })),
  );

  let moqModule: Awaited<typeof import('@moq/net')> | null = null;
  let watchModule: Awaited<typeof import('@moq/watch')> | null = null;
  let signalsModule: Awaited<typeof import('@moq/signals')> | null = null;

  const ensureMoqModules = async () => {
    if (import.meta.server) {
      throw new Error(strings.liveBrowserOnly);
    }
    if (!moqModule || !watchModule || !signalsModule) {
      const [moq, watch, signals] = await Promise.all([
        import('@moq/net'),
        import('@moq/watch'),
        import('@moq/signals'),
      ]);
      moqModule = moq;
      watchModule = watch;
      signalsModule = signals;
    }
    return { moq: moqModule, watch: watchModule, signals: signalsModule };
  };

  // ── Auth — userId now comes from the session, not a query param ──────────────
  //
  // For logged-in users the API looks up their subscription and returns the
  // correct hasAccess / playlistUrl for their plan.
  const { isLoggedIn, authHeader } = useAuth();
  const { getOfflineSource } = useOfflineDownloads();
  const playingOffline = ref(false);
  const { startLoginFlow } = useLoginFlow();
  const { returningFromStripe, completeStripeCheckoutReturn, clearStripeSessionQuery } =
    useStripeCheckoutReturn();
  const { returningFromLegacy, completeLegacyCheckoutReturn, clearLegacyOrderQuery } =
    useLegacyCheckoutReturn();

  const isSeekingPlayback = ref(false);
  const isActivelyWatching = ref(false);
  const activePlayerVideoId = ref<string | null>(null);
  let pendingResumeSeconds: number | null = null;
  let resumeAppliedForVideoId: string | null = null;

  type MediaLikeElement = HTMLElement & {
    src: string;
    currentTime: number;
    muted: boolean;
    playbackRate: number;
    readyState: number;
    pause: () => void;
    play: () => Promise<void>;
    load: () => void;
    setAttribute: (name: string, value: string) => void;
    addEventListener: HTMLElement['addEventListener'];
    removeEventListener: HTMLElement['removeEventListener'];
    nativeEl?: HTMLVideoElement;
    webkitEnterFullscreen?: () => void;
    webkitShowPlaybackTargetPicker?: () => void;
  };

  type FullscreenDocument = Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
    webkitCancelFullScreen?: () => Promise<void> | void;
  };

  type FullscreenElement = HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
    webkitRequestFullScreen?: () => Promise<void> | void;
  };

  type WebKitVideoElement = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitSetPresentationMode?: (mode: 'fullscreen' | 'inline' | 'picture-in-picture') => void;
    webkitShowPlaybackTargetPicker?: () => void;
  };

  type ScreenWithOrientationLock = Screen & {
    orientation?: ScreenOrientation & {
      lock?: (orientation: OrientationLockType) => Promise<void>;
      unlock?: () => void;
    };
  };

  const { playbackRate, applyPlaybackRate, setPlaybackRate } = usePlaybackRate();

  const videoElement = ref<MediaLikeElement | null>(null);
  const mediaControllerRef = ref<FullscreenElement | null>(null);
  const mobileSettingsMenuRef = ref<HTMLElement | null>(null);
  const loading = ref(true);
  const isNavigatingToAnotherVideo = ref(false);
  const error = ref<string | null>(null);
  const videoData = ref<any>(null);
  const recommendations = ref<any[]>([]);
  const showPremiumOverlay = ref(false);
  const buffering = ref(false);
  const currentTime = ref(0);
  const rateLimited = ref(false);
  const rateLimitRetryAfter = ref<number | null>(null);
  const rateLimitCurrent = ref(0);
  const rateLimitLimit = ref(0);
  const playbackUnavailable = ref(false);
  const autoplayBlocked = ref(false);
  const autoplayMuting = ref(false);
  const autoplayPlayError = ref(false);
  const airplayAvailable = ref(false);
  const isPlayerFullscreen = ref(false);
  const mobileSettingsOpen = ref(false);
  const videoFillMode = ref<'contain' | 'cover'>('contain');
  const liveCanvas = ref<HTMLCanvasElement | null>(null);
  const playbackRateOptions = PLAYBACK_RATE_OPTIONS;

  async function handleRateLimitSignIn() {
    await startLoginFlow(`/watch/${encodeURIComponent(videoId.value)}`);
  }

  const {
    shellRef: liveMoqShellRef,
    attach: attachLiveMoqControls,
    detach: detachLiveMoqControls,
    isPaused: liveMoqIsPaused,
    volume01: liveMoqVolume,
    isMuted: liveMoqIsMuted,
    togglePause: liveMoqTogglePause,
    goLive: liveMoqGoLive,
    toggleMute: liveMoqToggleMute,
    setVolume: liveMoqSetVolume,
    toggleFullscreen: liveMoqToggleFullscreen,
  } = useMoqLivePlayerControls();

  const handleLiveMoqPlayPause = () => {
    if (liveMoqIsPaused.value) liveMoqGoLive();
    else liveMoqTogglePause();
  };

  const onLiveMoqVolumeInput = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const v = Number.parseFloat(input.value);
    if (Number.isFinite(v)) liveMoqSetVolume(v);
  };

  const videoId = computed(() => String(route.params.videoId ?? ''));

  // Resolved actual duration (from HLS playlist parsing) when D1 returns 0
  const resolvedFullDuration = ref(0);

  const effectiveFullDuration = computed(
    () => resolvedFullDuration.value || videoData.value?.video?.fullDuration || 0,
  );

  const playbackPositionEnabled = computed(
    () =>
      isLoggedIn.value &&
      Boolean(videoData.value?.hasAccess) &&
      !videoData.value?.video?.isLivestream,
  );

  const playbackResumeHint = computed(() => {
    if (!videoData.value || videoData.value.video?.isLivestream) return null;
    if (isFullPublicPreview.value) return null;
    if (playbackPositionEnabled.value) return null;
    if (isLoggedIn.value && !videoData.value.hasAccess) {
      return strings.playbackResumeRequiresSubscription;
    }
    return strings.playbackResumeRequiresSignIn;
  });

  const resumeAppliedNotice = ref<string | null>(null);
  let resumeNoticeTimeout: ReturnType<typeof setTimeout> | null = null;

  const {
    fetchSavedPosition,
    flush: flushPlaybackPosition,
    resetLocalState: resetPlaybackPositionState,
  } = usePlaybackPosition({
    apiUrl: () => String(config.public.apiUrl),
    authHeader,
    enabled: () => playbackPositionEnabled.value,
    videoId: () => String(videoData.value?.videoId ?? videoId.value),
    getPosition: () => {
      // Prefer an unapplied resume target so navigate-away before seek does not clear it.
      if (pendingResumeSeconds != null && pendingResumeSeconds > currentTime.value) {
        return pendingResumeSeconds;
      }
      return currentTime.value;
    },
    getDuration: () => effectiveFullDuration.value,
    isSeeking: () => isSeekingPlayback.value,
    isActivelyWatching: () => isActivelyWatching.value,
  });

  /** Full-length preview for non-subscribers (admin set preview lock to full duration). */
  const isFullPublicPreview = computed(() => {
    const v = videoData.value;
    if (!v?.video || v.hasAccess) return false;
    const prev = v.video.previewDuration;
    const full = effectiveFullDuration.value;
    const EPSILON_SECONDS = 0.5;
    return typeof prev === 'number' && full > 0 && prev >= full - EPSILON_SECONDS;
  });
  const hasLivestreamMoqSource = computed(() =>
    Boolean(
      videoData.value?.video?.isLivestream &&
        typeof videoData.value?.video?.livestreamMoqEndpoint === 'string' &&
        videoData.value?.video?.livestreamMoqEndpoint.trim().length > 0 &&
        typeof videoData.value?.video?.livestreamMoqBroadcast === 'string' &&
        videoData.value?.video?.livestreamMoqBroadcast.trim().length > 0,
    ),
  );
  const hasLivestreamPlaybackSource = computed(() =>
    Boolean(
      videoData.value?.video?.isLivestream &&
        typeof videoData.value?.video?.playlistUrl === 'string' &&
        videoData.value?.video?.playlistUrl.trim().length > 0,
    ),
  );
  const hasAnyLivestreamPlaybackSource = computed(
    () => hasLivestreamMoqSource.value || hasLivestreamPlaybackSource.value,
  );

  // ── Computed helpers ─────────────────────────────────────────────────────────

  const progressPercentage = computed(() => {
    const duration = effectiveFullDuration.value;
    if (!duration) return 0;
    return Math.min(100, (currentTime.value / duration) * 100);
  });

  const previewPercentage = computed(() => {
    if (!videoData.value) return 0;
    const full = effectiveFullDuration.value;
    if (!full) return 0;
    return (Math.min(videoData.value.video.previewDuration, full) / full) * 100;
  });

  const videoDescription = computed(() => {
    const rawDescription = videoData.value?.video?.description;
    if (typeof rawDescription !== 'string') return strings.noDescription;
    const trimmedDescription = rawDescription.trim();
    return trimmedDescription ? trimmedDescription : strings.noDescription;
  });
  const videoDescriptionHtml = computed(() => renderMarkdownToHtml(videoDescription.value));

  const descriptionRef = ref<HTMLElement | null>(null);
  const descriptionExpanded = ref(false);
  const descriptionClamped = ref(false);

  function cssLengthToPx(length: string, context: HTMLElement): number {
    const trimmed = length.trim();
    if (!trimmed || trimmed === 'none') return 0;
    if (trimmed.endsWith('px')) return Number.parseFloat(trimmed) || 0;
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;height:${trimmed};width:0;overflow:hidden;`;
    context.appendChild(probe);
    const px = probe.offsetHeight;
    context.removeChild(probe);
    return px;
  }

  /** Read `.watch-description-collapsed` max-height in the element's rem/px context. */
  function getDescriptionCollapsedMaxPx(el: HTMLElement): number {
    const hadClass = el.classList.contains('watch-description-collapsed');
    if (!hadClass) el.classList.add('watch-description-collapsed');
    const collapsedMaxPx = cssLengthToPx(getComputedStyle(el).maxHeight, el);
    if (!hadClass) el.classList.remove('watch-description-collapsed');
    return collapsedMaxPx;
  }

  function measureDescriptionClamp(options?: { resetExpanded?: boolean }) {
    if (options?.resetExpanded) descriptionExpanded.value = false;
    nextTick(() => {
      const el = descriptionRef.value;
      if (!el) {
        descriptionClamped.value = false;
        return;
      }
      const collapsedMaxPx = getDescriptionCollapsedMaxPx(el);
      if (descriptionExpanded.value) {
        descriptionClamped.value = el.scrollHeight > collapsedMaxPx + 2;
      } else {
        descriptionClamped.value = el.scrollHeight > el.clientHeight + 2;
      }
    });
  }

  let descriptionClampResizeObserver: ResizeObserver | null = null;

  watch(videoDescriptionHtml, () => {
    measureDescriptionClamp({ resetExpanded: true });
  });
  watch(descriptionExpanded, () => {
    if (!descriptionExpanded.value) measureDescriptionClamp();
  });

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  function recommendationWatchPath(rec: { id: string; slug?: string | null }) {
    return `/watch/${encodeURIComponent(rec.slug ?? rec.id)}`;
  }

  const formatRetryAfter = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const getNativeVideoElement = (
    media: MediaLikeElement | null = videoElement.value,
  ): WebKitVideoElement | null => {
    if (!media || import.meta.server) return null;
    if (media.nativeEl instanceof HTMLVideoElement) return media.nativeEl;
    const shadowVideo = media.shadowRoot?.querySelector('video');
    return shadowVideo instanceof HTMLVideoElement ? shadowVideo : null;
  };

  /** Native <video> for seek/pause/time — reliable before videojs-video fully upgrades. */
  const getPlaybackVideo = (
    media: MediaLikeElement | null = videoElement.value,
  ): WebKitVideoElement | null => getNativeVideoElement(media);

  const resolveTimeUpdateTarget = (target: EventTarget | null): WebKitVideoElement | null => {
    if (target instanceof HTMLVideoElement) return target;
    if (target && typeof target === 'object') {
      return getPlaybackVideo(target as MediaLikeElement);
    }
    return getPlaybackVideo();
  };

  const setPlaybackTime = (
    seconds: number,
    media: MediaLikeElement | null = videoElement.value,
  ) => {
    const native = getPlaybackVideo(media);
    if (native) {
      native.currentTime = seconds;
      return;
    }
    if (media && 'currentTime' in media) media.currentTime = seconds;
  };

  const applyPendingResume = () => {
    const targetVideoId = String(videoData.value?.videoId ?? videoId.value);
    if (pendingResumeSeconds == null) return;
    if (resumeAppliedForVideoId === targetVideoId) return;
    const duration = effectiveFullDuration.value;
    const resumeAt = pendingResumeSeconds;
    if (!shouldResumePlaybackPosition(resumeAt, duration || null)) {
      pendingResumeSeconds = null;
      return;
    }
    setPlaybackTime(resumeAt);
    currentTime.value = resumeAt;
    resumeAppliedForVideoId = targetVideoId;
    pendingResumeSeconds = null;

    resumeAppliedNotice.value = strings.playbackResumedAt(formatDuration(resumeAt));
    if (resumeNoticeTimeout) clearTimeout(resumeNoticeTimeout);
    resumeNoticeTimeout = setTimeout(() => {
      resumeAppliedNotice.value = null;
      resumeNoticeTimeout = null;
    }, 8000);
  };

  const pausePlayback = (media: MediaLikeElement | null = videoElement.value) => {
    const native = getPlaybackVideo(media);
    if (native) {
      native.pause();
      return;
    }
    const el = media as (MediaLikeElement & { api?: { pause?: () => void } }) | null;
    if (el?.api && typeof el.api.pause === 'function') {
      el.api.pause();
      return;
    }
    if (media && typeof media.pause === 'function') media.pause();
  };

  const playPlayback = async (media: MediaLikeElement | null = videoElement.value) => {
    const native = getPlaybackVideo(media);
    if (native) {
      await native.play().catch(() => {});
      return;
    }
    const el = media as (MediaLikeElement & { api?: { play?: () => Promise<void> | void } }) | null;
    if (el?.api && typeof el.api.play === 'function') {
      await Promise.resolve(el.api.play()).catch(() => {});
      return;
    }
    if (media && typeof media.play === 'function') {
      await media.play().catch(() => {});
    }
  };

  const handleMediaPauseRequest = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    pausePlayback();
  };

  const handleMediaPlayRequest = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void playPlayback();
  };

  const handleUnmuteBannerClick = async () => {
    const video = videoElement.value;
    if (!video) return;
    video.muted = false;
    autoplayMuting.value = false;
    await playPlayback(video);
  };

  const isIosLikeDevice = () => {
    if (import.meta.server) return false;
    const nav = navigator;
    return (
      /iPad|iPhone|iPod/.test(nav.userAgent) ||
      (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
    );
  };

  const configureNativeVideoFeatures = (nativeVideo: HTMLVideoElement | null) => {
    if (!nativeVideo) return;
    nativeVideo.setAttribute('x-webkit-airplay', 'allow');
    (nativeVideo as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback =
      false;
    nativeVideo.style.objectFit = videoFillMode.value;
  };

  const updateAirplayAvailability = () => {
    const nativeVideo = getNativeVideoElement();
    airplayAvailable.value = Boolean(
      nativeVideo?.webkitShowPlaybackTargetPicker &&
        (isIosLikeDevice() ||
          typeof (window as Window & { WebKitPlaybackTargetAvailabilityEvent?: unknown })
            .WebKitPlaybackTargetAvailabilityEvent !== 'undefined'),
    );
  };

  const handleAirplayButtonClick = () => {
    const nativeVideo = getNativeVideoElement();
    if (!nativeVideo?.webkitShowPlaybackTargetPicker) {
      airplayAvailable.value = false;
      return;
    }
    nativeVideo.webkitShowPlaybackTargetPicker();
  };

  const getDocumentFullscreenElement = () => {
    if (import.meta.server) return null;
    const fullscreenDocument = document as FullscreenDocument;
    return document.fullscreenElement || fullscreenDocument.webkitFullscreenElement || null;
  };

  const updatePlayerFullscreenState = () => {
    const fullscreenElement = getDocumentFullscreenElement();
    isPlayerFullscreen.value = Boolean(
      fullscreenElement &&
        (fullscreenElement === mediaControllerRef.value ||
          mediaControllerRef.value?.contains(fullscreenElement)),
    );
    if (!isPlayerFullscreen.value) {
      mobileSettingsOpen.value = false;
      unlockLandscapeOrientation();
    }
  };

  const lockLandscapeOrientation = async () => {
    const orientation = (screen as ScreenWithOrientationLock | undefined)?.orientation;
    if (!orientation?.lock) return;
    try {
      await orientation.lock('landscape');
    } catch {
      // Browser support varies; fullscreen still works when orientation lock is denied.
    }
  };

  const unlockLandscapeOrientation = () => {
    const orientation = (screen as ScreenWithOrientationLock | undefined)?.orientation;
    try {
      orientation?.unlock?.();
    } catch {
      // Ignore unsupported unlocks.
    }
  };

  const requestElementFullscreen = async (element: FullscreenElement) => {
    if (element.requestFullscreen) {
      await element.requestFullscreen({ navigationUI: 'hide' });
      return true;
    }
    if (element.webkitRequestFullscreen) {
      await element.webkitRequestFullscreen();
      return true;
    }
    if (element.webkitRequestFullScreen) {
      await element.webkitRequestFullScreen();
      return true;
    }
    return false;
  };

  const exitElementFullscreen = async () => {
    const fullscreenDocument = document as FullscreenDocument;
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (fullscreenDocument.webkitExitFullscreen) {
      await fullscreenDocument.webkitExitFullscreen();
    } else if (fullscreenDocument.webkitCancelFullScreen) {
      await fullscreenDocument.webkitCancelFullScreen();
    }
    unlockLandscapeOrientation();
    updatePlayerFullscreenState();
  };

  const enterNativeVideoFullscreen = () => {
    const nativeVideo = getNativeVideoElement();
    if (!nativeVideo) return false;
    if (nativeVideo.webkitEnterFullscreen) {
      nativeVideo.webkitEnterFullscreen();
      return true;
    }
    if (nativeVideo.webkitSetPresentationMode) {
      nativeVideo.webkitSetPresentationMode('fullscreen');
      return true;
    }
    return false;
  };

  const handleFullscreenButtonClick = async () => {
    mobileSettingsOpen.value = false;
    if (isPlayerFullscreen.value || getDocumentFullscreenElement()) {
      await exitElementFullscreen();
      return;
    }

    if (isIosLikeDevice() && enterNativeVideoFullscreen()) {
      return;
    }

    const target = mediaControllerRef.value ?? videoElement.value;
    if (!target) return;

    try {
      const entered = await requestElementFullscreen(target);
      if (!entered && enterNativeVideoFullscreen()) return;
      updatePlayerFullscreenState();
      if (getDocumentFullscreenElement()) await lockLandscapeOrientation();
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('Fullscreen request failed', err);
      }
    }
  };

  const toggleMobileSettings = () => {
    mobileSettingsOpen.value = !mobileSettingsOpen.value;
  };

  const handleMobilePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    const native = getPlaybackVideo();
    if (native) native.playbackRate = rate;
    else if (videoElement.value) videoElement.value.playbackRate = rate;
    mobileSettingsOpen.value = false;
  };

  const isPlaybackRateSelected = (rate: number) => Math.abs(playbackRate.value - rate) < 0.001;

  const closeMobileSettingsFromDocument = (event: MouseEvent | PointerEvent | TouchEvent) => {
    if (!mobileSettingsOpen.value) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (mobileSettingsMenuRef.value?.contains(target)) return;
    if (target instanceof Element && target.closest('.watch-settings-menu-button')) return;
    mobileSettingsOpen.value = false;
  };

  const applyVideoFillMode = () => {
    const nativeVideo = getNativeVideoElement();
    if (nativeVideo) nativeVideo.style.objectFit = videoFillMode.value;
  };

  const getTouchDistance = (touches: TouchList) => {
    if (touches.length < 2) return null;
    const [first, second] = [touches.item(0), touches.item(1)];
    if (!first || !second) return null;
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  };

  let touchStartY = 0;
  let touchStartX = 0;
  let pinchStartDistance: number | null = null;
  let swipeExitInProgress = false;

  const handlePlayerTouchStart = (event: TouchEvent) => {
    if (!isPlayerFullscreen.value) return;
    if (event.touches.length === 2) {
      pinchStartDistance = getTouchDistance(event.touches);
      return;
    }
    if (event.touches.length === 1) {
      const touch = event.touches.item(0);
      if (!touch) return;
      touchStartY = touch.clientY;
      touchStartX = touch.clientX;
    }
  };

  const handlePlayerTouchMove = (event: TouchEvent) => {
    if (!isPlayerFullscreen.value) return;
    if (event.touches.length === 2 && pinchStartDistance) {
      const distance = getTouchDistance(event.touches);
      if (!distance) return;
      const delta = distance - pinchStartDistance;
      if (delta > 36 && videoFillMode.value !== 'cover') {
        videoFillMode.value = 'cover';
        applyVideoFillMode();
      } else if (delta < -36 && videoFillMode.value !== 'contain') {
        videoFillMode.value = 'contain';
        applyVideoFillMode();
      }
      return;
    }
    if (event.touches.length !== 1 || swipeExitInProgress) return;
    const touch = event.touches.item(0);
    if (!touch) return;
    const deltaY = touch.clientY - touchStartY;
    const deltaX = Math.abs(touch.clientX - touchStartX);
    if (deltaY > 90 && deltaX < 80) {
      swipeExitInProgress = true;
      exitElementFullscreen().finally(() => {
        swipeExitInProgress = false;
      });
    }
  };

  const handlePlayerTouchEnd = () => {
    pinchStartDistance = null;
    touchStartY = 0;
    touchStartX = 0;
  };

  const handleDocumentFullscreenChange = () => {
    updatePlayerFullscreenState();
  };

  // ── Event handlers ────────────────────────────────────────────────────────────

  const handleTimeUpdate = (event: Event) => {
    const video = resolveTimeUpdateTarget(event.target);
    if (!video) return;
    currentTime.value = video.currentTime;
    isActivelyWatching.value = !video.paused;
    if (video.paused) {
      clearPreviewEndTimer();
    }
    enforcePreviewLimit(video);
  };

  const handleVideoPlay = () => {
    isActivelyWatching.value = true;
    const video = resolveTimeUpdateTarget(videoElement.value);
    if (video) schedulePreviewEndOverlay(video);
  };

  const handleVideoPause = () => {
    isActivelyWatching.value = false;
    clearPreviewEndTimer();
  };

  usePushAttribution({
    videoId: () => videoId.value,
    currentTime: () => currentTime.value,
    duration: () => effectiveFullDuration.value,
  });

  const handleSeeking = (event: Event) => {
    isSeekingPlayback.value = true;
    const video = resolveTimeUpdateTarget(event.target);
    if (!video) return;
    enforcePreviewLimit(video);
  };

  const handleSeeked = () => {
    isSeekingPlayback.value = false;
    const video = resolveTimeUpdateTarget(videoElement.value);
    if (video) schedulePreviewEndOverlay(video);
  };

  const handleSeekbarInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const requestedTime = Number(input.value);
    const previewDuration = videoData.value?.video?.previewDuration;

    if (!videoData.value?.hasAccess && previewDuration && requestedTime >= previewDuration) {
      if (isFullPublicPreview.value) {
        currentTime.value = requestedTime;
        setPlaybackTime(requestedTime);
        return;
      }
      input.value = String(previewDuration);
      currentTime.value = previewDuration;
      setPlaybackTime(previewDuration);
      pausePlayback();
      showPremiumOverlay.value = true;
      return;
    }

    currentTime.value = requestedTime;
    setPlaybackTime(requestedTime);
  };

  const enforcePreviewLimit = (video: HTMLVideoElement) => {
    const previewDuration = videoData.value?.video?.previewDuration;
    if (videoData.value?.hasAccess || !previewDuration || isFullPublicPreview.value) return;
    if (video.currentTime <= previewDuration) return;
    clearPreviewEndTimer();
    video.currentTime = previewDuration;
    video.pause();
    showPremiumOverlay.value = true;
  };

  let previewEndTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPreviewEndTimer(): void {
    if (previewEndTimer !== null) {
      clearTimeout(previewEndTimer);
      previewEndTimer = null;
    }
  }

  /** Fire the premium overlay at the preview end second (timeupdate is ~250 ms granular). */
  function schedulePreviewEndOverlay(video: HTMLVideoElement): void {
    clearPreviewEndTimer();
    const previewDuration = videoData.value?.video?.previewDuration;
    if (videoData.value?.hasAccess || !previewDuration || isFullPublicPreview.value) return;
    if (video.paused || video.ended) return;
    if (video.currentTime >= previewDuration) {
      enforcePreviewLimit(video);
      return;
    }
    const rate = video.playbackRate > 0 ? video.playbackRate : 1;
    const remainingMs = Math.max(0, ((previewDuration - video.currentTime) / rate) * 1000);
    previewEndTimer = setTimeout(() => {
      previewEndTimer = null;
      if (videoData.value?.hasAccess || isFullPublicPreview.value) return;
      if (video.paused || video.ended) return;
      if (video.currentTime >= previewDuration - 0.05) {
        enforcePreviewLimit(video);
      }
    }, remainingMs);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onMounted(async () => {
    document.addEventListener('fullscreenchange', handleDocumentFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleDocumentFullscreenChange);
    document.addEventListener('click', closeMobileSettingsFromDocument);
    document.addEventListener('touchstart', closeMobileSettingsFromDocument);

    measureDescriptionClamp();

    if (returningFromLegacy.value) {
      const result = await completeLegacyCheckoutReturn();
      if (result.ok || result.pending) {
        showPremiumOverlay.value = false;
        await loadVideoForRoute(videoId.value);
        await clearLegacyOrderQuery();
        return;
      }
      error.value = result.error ?? strings.checkoutStartFailed;
      showPremiumOverlay.value = true;
      await clearLegacyOrderQuery();
      return;
    }

    if (returningFromStripe.value) {
      const result = await completeStripeCheckoutReturn();
      if (result.ok || result.pending) {
        showPremiumOverlay.value = false;
        await loadVideoForRoute(videoId.value);
        await clearStripeSessionQuery();
        return;
      }
    }

    if (route.query.showPremium === '1' && route.query.showDownload !== '1') {
      showPremiumOverlay.value = true;
    }
  });

  if (import.meta.client && typeof ResizeObserver !== 'undefined') {
    descriptionClampResizeObserver = new ResizeObserver(() => {
      measureDescriptionClamp();
    });
    watch(
      descriptionRef,
      (el, _prev, onCleanup) => {
        descriptionClampResizeObserver?.disconnect();
        if (el) descriptionClampResizeObserver?.observe(el);
        onCleanup(() => descriptionClampResizeObserver?.disconnect());
      },
      { immediate: true },
    );
  }

  onUnmounted(() => {
    clearPreviewEndTimer();
    document.removeEventListener('fullscreenchange', handleDocumentFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', handleDocumentFullscreenChange);
    document.removeEventListener('click', closeMobileSettingsFromDocument);
    document.removeEventListener('touchstart', closeMobileSettingsFromDocument);
    descriptionClampResizeObserver?.disconnect();
    descriptionClampResizeObserver = null;
    teardownVideoListeners();
    teardownLivestreamRuntime();
  });

  let handleLoadedMetadata: (() => void) | null = null;
  let handleMediaError: (() => void) | null = null;
  let handleWaiting: (() => void) | null = null;
  let handlePlaying: (() => void) | null = null;
  let handleCanPlay: (() => void) | null = null;
  let handleRateChange: (() => void) | null = null;
  let handleNativeBeginFullscreen: (() => void) | null = null;
  let handleNativeEndFullscreen: (() => void) | null = null;
  let handleNativeTimeUpdate: (() => void) | null = null;
  let nativeVideoWithListeners: HTMLVideoElement | null = null;
  type Closable = { close?: () => void };
  type LivestreamRuntime = {
    /** Resources registered in construction order; closed in reverse on teardown. */
    closables: Closable[];
    /** True once attachLiveMoqControls ran for this runtime. */
    controlsAttached: boolean;
  };

  let livestreamRuntime: LivestreamRuntime | null = null;
  let reloadInFlight = false;
  let currentRouteRequestId = 0;
  let activeLoadAbortController: AbortController | null = null;

  /**
   * Drop every spinner the load path can raise. Each failure exit has to go through this
   * — `buffering` in particular is set right before the player is handed its source, so
   * missing it leaves the player spinning over a video that will never arrive.
   */
  const clearPlayerLoadingIndicators = () => {
    loading.value = false;
    isNavigatingToAnotherVideo.value = false;
    buffering.value = false;
  };

  /**
   * A failure inside a client-side route change never reaches Vue's error handler, so
   * every retry after the first one was silently invisible in error tracking.
   */
  const reportPlayerLoadFailure = (failure: unknown, failedVideoId: string) => {
    // Report the underlying fault, not the localized wrapper, so issues group by cause.
    const reported =
      failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure;
    captureBrowserException(reported, {
      surface: 'watch_player_init',
      video_id: failedVideoId,
    });
  };

  type FetchVideoAccessOptions = {
    videoId?: string;
    signal?: AbortSignal;
    guard?: () => boolean;
  };

  const fetchVideoAccess = async (options: FetchVideoAccessOptions = {}) => {
    const targetVideoId = options.videoId ?? (route.params.videoId as string);
    const guard = options.guard ?? (() => true);
    const ensureCurrent = () => {
      if (options.signal?.aborted || !guard()) {
        throw new DOMException('Request aborted', 'AbortError');
      }
    };

    ensureCurrent();
    const videoResponse = await fetch(`${config.public.apiUrl}/api/video-access/${targetVideoId}`, {
      headers: { ...authHeader() },
      signal: options.signal,
    });
    ensureCurrent();

    if (videoResponse.status === 404) {
      markVideoNotFoundResponse();
      await loadBrowseRecommendations(options.signal);
      return;
    }

    if (videoResponse.status === 429) {
      const data = await videoResponse.json().catch(() => ({}));
      ensureCurrent();
      if (data.error === 'rate_limit_exceeded' && data.loginPrompt === true) {
        rateLimited.value = true;
        rateLimitRetryAfter.value = data.retryAfter ?? null;
        rateLimitCurrent.value = data.current ?? data.limit ?? 0;
        rateLimitLimit.value = data.limit ?? data.current ?? 0;
        return;
      }
      throw new Error(strings.rateLimitExceeded);
    }

    if (!videoResponse.ok) throw new Error(strings.videoLoadFailed);
    const data = await videoResponse.json();
    ensureCurrent();
    accessNotFound.value = false;
    videoData.value = data;
    rateLimited.value = false;
    rateLimitRetryAfter.value = null;
    rateLimitCurrent.value = 0;
    rateLimitLimit.value = 0;

    // If D1 has no duration stored yet (new draft auto-registered from R2),
    // parse the HLS playlist to get the real duration.
    resolvedFullDuration.value = 0;
    if (!videoData.value?.video?.fullDuration) {
      const playlistUrl = videoData.value?.video?.playlistUrl;
      if (playlistUrl) {
        const resolved = await resolvePlaylistDuration(playlistUrl);
        ensureCurrent();
        if (resolved) resolvedFullDuration.value = resolved;
      }
    }
  };

  const createLoadInvocation = () => {
    if (activeLoadAbortController) {
      activeLoadAbortController.abort();
    }

    const requestId = ++currentRouteRequestId;
    const abortController = new AbortController();
    activeLoadAbortController = abortController;
    const isCurrentInvocation = () =>
      currentRouteRequestId === requestId &&
      activeLoadAbortController === abortController &&
      !abortController.signal.aborted;

    const cancel = () => {
      if (activeLoadAbortController === abortController) {
        activeLoadAbortController = null;
      }
      abortController.abort();
    };

    return { abortController, isCurrentInvocation, cancel };
  };

  type LoadVideoForRouteOptions = {
    signal?: AbortSignal;
    guard?: () => boolean;
  };

  const loadBrowseRecommendations = async (signal?: AbortSignal) => {
    recommendations.value = [];
    try {
      const recsResponse = await fetch(`${config.public.apiUrl}/api/videos`, { signal });
      if (!recsResponse.ok) return;
      const data = await recsResponse.json();
      recommendations.value = (data.videos || []).slice(0, 9);
    } catch (e: any) {
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
    }
  };

  const waitForVideoMeta = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (!videoMetaPending.value) {
        resolve();
        return;
      }
      const stopPending = watch(videoMetaPending, (pending) => {
        if (!pending) {
          stopPending();
          resolve();
        }
      });
      signal?.addEventListener(
        'abort',
        () => {
          stopPending();
          reject(new DOMException('Request aborted', 'AbortError'));
        },
        { once: true },
      );
    });

  const loadVideoForRoute = async (
    targetVideoId: string,
    options: LoadVideoForRouteOptions = {},
  ) => {
    const guard = options.guard ?? (() => true);
    const ensureCurrent = () => {
      if (options.signal?.aborted || !guard()) {
        throw new DOMException('Request aborted', 'AbortError');
      }
    };

    ensureCurrent();

    const prevAccessNotFound = accessNotFound.value;
    const prevPlaybackUnavailable = playbackUnavailable.value;
    const prevRateLimited = rateLimited.value;
    const prevVideoNotFound = videoNotFound.value;

    // Route watcher / pagehide flush the previous video; do not flush here with
    // a zeroed playhead or we would clear the saved resume point before GET.
    pendingResumeSeconds = null;
    resumeAppliedForVideoId = null;
    resumeAppliedNotice.value = null;
    if (resumeNoticeTimeout) {
      clearTimeout(resumeNoticeTimeout);
      resumeNoticeTimeout = null;
    }
    resetPlaybackPositionState();
    isSeekingPlayback.value = false;
    isActivelyWatching.value = false;

    accessNotFound.value = false;
    playbackUnavailable.value = false;
    autoplayBlocked.value = false;
    autoplayMuting.value = false;
    buffering.value = false;
    autoplayPlayError.value = false;
    showPremiumOverlay.value = false;
    rateLimited.value = false;
    currentTime.value = 0;
    playingOffline.value = false;
    const preserveWatchShell = Boolean(
      videoData.value &&
        !prevAccessNotFound &&
        !prevPlaybackUnavailable &&
        !prevVideoNotFound &&
        !prevRateLimited,
    );
    isNavigatingToAnotherVideo.value = preserveWatchShell;
    if (!preserveWatchShell) {
      loading.value = true;
    }
    error.value = null;
    teardownLivestreamRuntime();

    await waitForVideoMeta(options.signal);
    ensureCurrent();

    if (videoNotFound.value) {
      markVideoNotFoundResponse();
      recommendations.value = [];
      await loadBrowseRecommendations(options.signal);
      ensureCurrent();
      loading.value = false;
      isNavigatingToAnotherVideo.value = false;
      return;
    }

    try {
      await fetchVideoAccess({
        videoId: targetVideoId,
        signal: options.signal,
        guard,
      });
      ensureCurrent();

      if (accessNotFound.value || showVideoNotFound.value) {
        loading.value = false;
        isNavigatingToAnotherVideo.value = false;
        return;
      }

      if (isLoggedIn.value && videoData.value?.hasAccess && !videoData.value?.video?.isLivestream) {
        const saved = await fetchSavedPosition(String(videoData.value?.videoId ?? targetVideoId));
        ensureCurrent();
        if (shouldResumePlaybackPosition(saved, videoData.value?.video?.fullDuration ?? null)) {
          pendingResumeSeconds = saved;
        }
      }

      // Recommendations are off the startup critical path — warm them in parallel.
      recommendations.value = [];
      const recommendationsPromise = (async () => {
        try {
          const recsResponse = await fetch(
            `${config.public.apiUrl}/api/recommendations?videoId=${encodeURIComponent(String(videoData.value?.videoId ?? targetVideoId))}&limit=5`,
            { signal: options.signal },
          );
          if (!guard() || options.signal.aborted) return;
          if (recsResponse.ok) {
            const recommendationsData = await recsResponse.json();
            if (!guard() || options.signal.aborted) return;
            recommendations.value = recommendationsData.videos || [];
          }
        } catch (e: any) {
          if (e?.name === 'AbortError' || options.signal?.aborted || !guard()) throw e;
        }
      })();

      ensureCurrent();
      loading.value = false;
      isNavigatingToAnotherVideo.value = false;
      await nextTick();
      measureDescriptionClamp();
      ensureCurrent();
      if (videoData.value?.video?.isLivestream) {
        await recommendationsPromise.catch(() => undefined);
        if (hasLivestreamMoqSource.value && !rateLimited.value) {
          error.value = null;
          await initializeLivestreamRuntime(
            String(videoData.value.video.livestreamMoqEndpoint),
            String(videoData.value.video.livestreamMoqBroadcast),
            guard,
            options.signal,
          );
          ensureCurrent();
          assignActivePlayerVideoIdIfCurrent(
            activePlayerVideoId,
            videoData.value?.videoId ?? targetVideoId,
            guard,
          );
        }
        return;
      }
      const playlistUrl = videoData.value?.video?.playlistUrl;
      // Warm cheapest rung + first segments while Video.js boots (and share Worker cache).
      if (playlistUrl && !rateLimited.value) {
        void import('~/utils/hlsStartupPrefetch')
          .then(({ prefetchHlsStartup }) =>
            prefetchHlsStartup(playlistUrl, {
              segmentCount: 2,
              signal: options.signal,
              priority: 'high',
            }),
          )
          .catch(() => undefined);
      }
      // Availability preflight runs in parallel with player init; player error path
      // still surfaces storage failures if the preflight loses the race.
      const availabilityPromise =
        playlistUrl && !rateLimited.value
          ? checkPlaylistAvailability(playlistUrl, options.signal)
          : Promise.resolve({ ok: true as const });

      if (playlistUrl && !rateLimited.value) {
        error.value = null;
        let resolvedPlaylist = playlistUrl;
        if (videoData.value?.hasAccess) {
          try {
            const offline = await getOfflineSource(
              String(videoData.value?.videoId ?? targetVideoId),
            );
            if (offline?.playlistUrl) {
              resolvedPlaylist = offline.playlistUrl;
              playingOffline.value = true;
              trackOfflineEvent('offline_playback_started', { videoId: targetVideoId });
            }
          } catch {
            playingOffline.value = false;
          }
        }
        const playerPromise = initializeVideoElement(resolvedPlaylist, guard, options.signal);
        const availability = await availabilityPromise;
        ensureCurrent();
        if (!availability.ok && isPlaybackUnavailableCode(availability.code)) {
          playbackUnavailable.value = true;
          await loadBrowseRecommendations(options.signal);
          ensureCurrent();
          loading.value = false;
          isNavigatingToAnotherVideo.value = false;
          return;
        }
        await playerPromise;
        ensureCurrent();
        assignActivePlayerVideoIdIfCurrent(
          activePlayerVideoId,
          videoData.value?.videoId ?? targetVideoId,
          guard,
        );
      }
      await recommendationsPromise.catch(() => undefined);
    } catch (e: any) {
      const superseded = e?.name === 'AbortError' || options.signal?.aborted || !guard();
      if (superseded) {
        // A stale invocation must not paint over a newer one that owns the UI. But if
        // no load is in flight any more, these spinners are ours and nothing else will
        // ever clear them — leaving them up is the stuck-forever spinner.
        if (!activeLoadAbortController || activeLoadAbortController.signal === options.signal) {
          clearPlayerLoadingIndicators();
        }
        return;
      }
      if (isPlaybackUnavailableError(e)) {
        error.value = null;
        playbackUnavailable.value = true;
        await loadBrowseRecommendations(options.signal);
      } else {
        error.value = e.message;
        reportPlayerLoadFailure(e, targetVideoId);
      }
      clearPlayerLoadingIndicators();
    }
  };

  const initializeLivestreamRuntime = async (
    moqEndpoint: string,
    moqBroadcast: string,
    isCurrentInvocation: () => boolean = () => true,
    signal?: AbortSignal,
  ) => {
    const ensureActive = () => {
      if (signal?.aborted || !isCurrentInvocation()) {
        throw new DOMException('Request aborted', 'AbortError');
      }
    };

    ensureActive();
    const canvas = liveCanvas.value;
    if (!canvas) throw new Error(strings.liveCanvasUnavailable);

    teardownVideoListeners();
    teardownLivestreamRuntime();
    const partialRuntime: LivestreamRuntime = {
      closables: [],
      controlsAttached: false,
    };
    const track = <T extends Closable>(resource: T): T => {
      partialRuntime.closables.push(resource);
      return resource;
    };

    try {
      const { moq, watch, signals } = await ensureMoqModules();
      const { Signal } = signals;

      const connection = track(
        new moq.Connection.Reload({
          url: new URL(moqEndpoint),
          enabled: true,
        }),
      );

      const paused = new Signal(false);
      const volume = new Signal(0.85);
      const muted = new Signal(false);
      // Match <moq-watch> default: wait for (re)announcement before subscribing.
      const reload = new Signal(true);
      const videoEnabled = new Signal(true);
      const audioEnabled = new Signal(true);

      const broadcast = track(
        new watch.Broadcast({
          connection: connection.established,
          enabled: true,
          name: moq.Path.from(moqBroadcast),
          reload,
        }),
      );

      const videoSource = track(
        new watch.Video.Source({
          broadcast,
          supported: watch.Video.Decoder.supported,
        }),
      );
      const audioSource = track(
        new watch.Audio.Source({
          broadcast,
          supported: watch.Audio.Decoder.supported,
        }),
      );
      const sync = track(
        new watch.Sync({
          latency: 'real-time',
          connection: connection.established,
          video: videoSource.out.jitter,
          audio: audioSource.out.jitter,
        }),
      );
      const videoDecoder = track(
        new watch.Video.Decoder(videoSource, sync, { enabled: videoEnabled }),
      );
      const audioDecoder = track(
        new watch.Audio.Decoder(audioSource, sync, { enabled: audioEnabled }),
      );
      const emitter = track(new watch.Audio.Emitter(audioDecoder, { volume, muted, paused }));
      const renderer = track(
        new watch.Video.Renderer(videoDecoder, {
          canvas,
          visible: 'always',
        }),
      );

      // Mirror <moq-watch>: audio Decoder.enabled follows Emitter.out.enabled
      // (false while paused/muted path); keep video downloading so the canvas
      // retains the last frame while paused.
      track(
        new signals.Effect((effect) => {
          audioEnabled.set(effect.get(emitter.out.enabled));
          videoEnabled.set(true);
        }),
      );

      attachLiveMoqControls({
        paused,
        volume,
        muted,
        reload,
        resetSync: () => {
          sync.reset();
          audioDecoder.reset();
        },
      });
      partialRuntime.controlsAttached = true;

      ensureActive();
      livestreamRuntime = partialRuntime;
    } catch (error) {
      teardownLivestreamRuntime(partialRuntime);
      throw error;
    }
  };

  watch(isLoggedIn, async (loggedIn, wasLoggedIn, onCleanup) => {
    if (!loggedIn || wasLoggedIn || reloadInFlight) return;

    reloadInFlight = true;
    const { abortController, isCurrentInvocation, cancel } = createLoadInvocation();
    onCleanup(() => {
      cancel();
    });

    try {
      await loadVideoForRoute(String(route.params.videoId), {
        signal: abortController.signal,
        guard: isCurrentInvocation,
      });
    } finally {
      reloadInFlight = false;
    }
  });

  const initializeVideoElement = async (
    playlistUrl: string,
    isCurrentInvocation: () => boolean = () => true,
    signal?: AbortSignal,
  ) => {
    const ensureActive = () => {
      if (signal?.aborted || !isCurrentInvocation()) {
        throw new DOMException('Request aborted', 'AbortError');
      }
    };

    ensureActive();

    // Load the player bundle on demand (not on the homepage entry chunk).
    const { ensureVideojsElementReady } = await import('~/lib/videojsBootstrap');
    ensureActive();

    const video = videoElement.value;
    if (!video) throw new Error(strings.videoElementUnavailable);
    ensureActive();

    // Everything below reads the element's internals — the shadow <video> and, once we
    // set src, its Video.js `api`. Registering the class is not enough: wait for this
    // instance to be upgraded, connected, and to have built its player, or the load()
    // that setting src triggers throws "this.api is undefined" and the player dies.
    try {
      await ensureVideojsElementReady(video, { signal });
    } catch (readinessError) {
      if (readinessError instanceof DOMException && readinessError.name === 'AbortError') {
        throw readinessError;
      }
      // Readiness failures carry internal player-plumbing messages; show the user the
      // same thing a missing element shows and keep the detail on `cause`.
      throw new Error(strings.videoElementUnavailable, { cause: readinessError });
    }
    ensureActive();

    teardownVideoListeners();
    ensureActive();

    handleLoadedMetadata = () => {
      if (!isCurrentInvocation()) return;
      applyPendingResume();
      if (import.meta.env.DEV) {
        console.log('Video metadata loaded');
      }
    };
    handleMediaError = () => {
      if (!isCurrentInvocation()) return;
      error.value = null;
      playbackUnavailable.value = true;
      void loadBrowseRecommendations(signal);
    };
    handleWaiting = () => {
      if (isCurrentInvocation()) buffering.value = true;
    };
    handlePlaying = () => {
      if (!isCurrentInvocation()) return;
      buffering.value = false;
      isActivelyWatching.value = true;
      const native = nativeVideoWithListeners ?? getNativeVideoElement(video);
      if (native) schedulePreviewEndOverlay(native);
    };
    handleCanPlay = () => {
      if (isCurrentInvocation()) buffering.value = false;
    };
    handleRateChange = () => {
      if (!isCurrentInvocation()) return;
      const rate = (video as HTMLMediaElement).playbackRate;
      if (Number.isFinite(rate)) setPlaybackRate(rate);
      const native = nativeVideoWithListeners ?? getNativeVideoElement(video);
      if (native) schedulePreviewEndOverlay(native);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('ratechange', handleRateChange);
    const nativeVideo = getNativeVideoElement(video);
    configureNativeVideoFeatures(nativeVideo);
    if (nativeVideo) {
      nativeVideoWithListeners = nativeVideo;
      handleNativeBeginFullscreen = () => {
        isPlayerFullscreen.value = true;
        mobileSettingsOpen.value = false;
      };
      handleNativeEndFullscreen = () => {
        isPlayerFullscreen.value = false;
        mobileSettingsOpen.value = false;
        unlockLandscapeOrientation();
      };
      nativeVideo.addEventListener('webkitbeginfullscreen', handleNativeBeginFullscreen);
      nativeVideo.addEventListener('webkitendfullscreen', handleNativeEndFullscreen);
      handleNativeTimeUpdate = () => {
        if (!isCurrentInvocation()) return;
        currentTime.value = nativeVideo.currentTime;
        isActivelyWatching.value = !nativeVideo.paused;
        enforcePreviewLimit(nativeVideo);
      };
      nativeVideo.addEventListener('timeupdate', handleNativeTimeUpdate);
    }
    ensureActive();

    buffering.value = true;
    autoplayBlocked.value = false;
    autoplayMuting.value = true;
    ensureActive();
    video.muted = true;
    video.setAttribute('src', playlistUrl);
    video.setAttribute('preload', 'auto');
    // videojs-video-element load() is async; await it so Video.js is initialized before play().
    await (video as HTMLMediaElement & { load(): Promise<void> }).load();
    configureNativeVideoFeatures(getNativeVideoElement(video));
    updateAirplayAvailability();

    // Check if video is already ready to avoid hanging on canplay
    if (video.readyState >= 3) {
      // HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA
      // Already ready, no need to wait
    } else {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('canplay', onCanPlay);
          video.removeEventListener('error', onError);
          signal?.removeEventListener('abort', onSignalAbort);
        };
        const onCanPlay = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new PlaybackUnavailableError());
        };
        const onSignalAbort = () => {
          cleanup();
          reject(new DOMException('Request aborted', 'AbortError'));
        };
        video.addEventListener('canplay', onCanPlay);
        video.addEventListener('error', onError);
        signal?.addEventListener('abort', onSignalAbort, { once: true });
      });
    }
    ensureActive();

    video.addEventListener('error', handleMediaError);

    applyPendingResume();
    applyPlaybackRate(video);

    try {
      await video.play();
      ensureActive();
      autoplayPlayError.value = false;
      isActivelyWatching.value = true;
    } catch (e: any) {
      if (e?.name === 'AbortError' || signal?.aborted || !isCurrentInvocation()) throw e;
      buffering.value = false;
      // Check if error is due to autoplay policy
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        autoplayBlocked.value = true;
      } else {
        // Media/network error
        autoplayPlayError.value = true;
        console.error('Video playback error:', e);
      }
    }
  };

  const handleAutoplayOverlayClick = async () => {
    const video = videoElement.value;
    if (!video) return;

    try {
      video.muted = false;
      await video.play();
      autoplayBlocked.value = false;
      autoplayMuting.value = false;
      autoplayPlayError.value = false;
    } catch (e: any) {
      // Check if error is due to autoplay policy
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        autoplayBlocked.value = true;
        autoplayMuting.value = true;
      } else {
        // Media/network error
        autoplayBlocked.value = false;
        autoplayPlayError.value = true;
        console.error('Video playback error:', e);
      }
    }
  };

  const handleUserPlaybackInteraction = (event: PointerEvent | MouseEvent | Event) => {
    if (!autoplayMuting.value) return;

    // Check if the click originated on or inside the media-mute-button
    const target = event.target as HTMLElement;
    const path = event.composedPath?.() || [];
    const isOnMuteButton =
      target.closest?.('media-mute-button') ||
      path.some((el: EventTarget) => (el as HTMLElement).tagName === 'MEDIA-MUTE-BUTTON');

    if (isOnMuteButton) return;

    const video = videoElement.value;
    if (!video) return;
    video.muted = false;
    autoplayMuting.value = false;
  };

  watch(
    [videoIdParam, videoMeta, canonicalWatchPath, videoMetaPending],
    async ([param, meta, path, metaPending]) => {
      if (import.meta.server || !meta || !path || !param || metaPending) return;
      // Meta can lag behind route changes during Up Next navigation; never redirect
      // using stale meta or we snap back to the previous video's canonical slug.
      if (!routeParamMatchesVideoMeta(param, meta)) return;
      const canonicalToken = decodeURIComponent(path.replace(/^\/watch\//, ''));
      if (param !== canonicalToken) {
        await navigateTo(path, { replace: true });
      }
    },
  );

  watch(
    () => route.params.videoId,
    async (newVideoId, _oldVideoId, onCleanup) => {
      if (newVideoId === _oldVideoId) return;
      const { abortController, isCurrentInvocation, cancel } = createLoadInvocation();

      onCleanup(() => {
        cancel();
      });

      const claimedVideoId = claimActivePlayerVideoIdForFlush(activePlayerVideoId);
      if (claimedVideoId) {
        await flushPlaybackPosition(claimedVideoId);
      }
      if (!isCurrentInvocation()) return;

      accessNotFound.value = false;
      descriptionExpanded.value = false;
      descriptionClamped.value = false;

      try {
        await waitForVideoMeta(abortController.signal);
      } catch (e: any) {
        if (e?.name === 'AbortError' || abortController.signal.aborted) return;
        throw e;
      }
      if (!isCurrentInvocation()) return;

      await loadVideoForRoute(String(newVideoId), {
        signal: abortController.signal,
        guard: isCurrentInvocation,
      });
    },
    { immediate: true },
  );

  function teardownVideoListeners() {
    const video = videoElement.value;
    if (video) {
      if (handleLoadedMetadata) {
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
        handleLoadedMetadata = null;
      }
      if (handleMediaError) {
        video.removeEventListener('error', handleMediaError);
        handleMediaError = null;
      }
      if (handleWaiting) {
        video.removeEventListener('waiting', handleWaiting);
        handleWaiting = null;
      }
      if (handlePlaying) {
        video.removeEventListener('playing', handlePlaying);
        handlePlaying = null;
      }
      if (handleCanPlay) {
        video.removeEventListener('canplay', handleCanPlay);
        handleCanPlay = null;
      }
      if (handleRateChange) {
        video.removeEventListener('ratechange', handleRateChange);
        handleRateChange = null;
      }
    }
    if (nativeVideoWithListeners) {
      if (handleNativeBeginFullscreen) {
        nativeVideoWithListeners.removeEventListener(
          'webkitbeginfullscreen',
          handleNativeBeginFullscreen,
        );
        handleNativeBeginFullscreen = null;
      }
      if (handleNativeEndFullscreen) {
        nativeVideoWithListeners.removeEventListener(
          'webkitendfullscreen',
          handleNativeEndFullscreen,
        );
        handleNativeEndFullscreen = null;
      }
      if (handleNativeTimeUpdate) {
        nativeVideoWithListeners.removeEventListener('timeupdate', handleNativeTimeUpdate);
        handleNativeTimeUpdate = null;
      }
      nativeVideoWithListeners = null;
    }
    airplayAvailable.value = false;
    isPlayerFullscreen.value = false;
    mobileSettingsOpen.value = false;
  }

  function teardownLivestreamRuntime(runtimeToDispose?: LivestreamRuntime | null) {
    const source = runtimeToDispose ?? livestreamRuntime;
    // Detach controls when tearing down the active runtime, or any runtime
    // that already attached MoQ controls.
    const shouldDetach =
      !runtimeToDispose ||
      runtimeToDispose === livestreamRuntime ||
      Boolean(source?.controlsAttached);
    if (shouldDetach) {
      detachLiveMoqControls();
    }
    const closables = source?.closables ?? [];
    for (let i = closables.length - 1; i >= 0; i -= 1) {
      try {
        closables[i]?.close?.();
      } catch {
        // Best-effort cleanup of partially constructed pipelines.
      }
    }
    if (source) source.closables = [];
    if (!runtimeToDispose || runtimeToDispose === livestreamRuntime) {
      livestreamRuntime = null;
    }
  }
</script>

<style scoped>
  .watch-media-controller {
    --media-control-background: transparent;
    --media-control-color: #ffffff;
    background: #000;
    touch-action: manipulation;
  }
  .watch-media-element {
    position: relative;
    z-index: 1;
  }

  .watch-media-controller:fullscreen,
  .watch-media-controller:-webkit-full-screen {
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    max-height: 100vh;
    aspect-ratio: auto;
    background: #000;
  }

  .watch-media-controller:fullscreen .watch-media-element,
  .watch-media-controller:-webkit-full-screen .watch-media-element {
    width: 100%;
    height: 100%;
  }

  .watch-controls-container {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 20;
    background: linear-gradient(
      to top,
      rgba(0, 0, 0, 0.9) 0%,
      rgba(0, 0, 0, 0.5) 60%,
      transparent 100%
    );
    display: flex;
    flex-direction: column;
  }

  .watch-seekbar-row {
    padding: 0 12px;
  }

  .watch-seekbar-wrap {
    position: relative;
    display: flex;
    align-items: center;
    height: 20px;
    cursor: pointer;
  }

  .watch-seekbar-input {
    margin: 0;
    padding: 0;
  }

  .watch-media-control-bar {
    position: relative;
    z-index: 20;
    padding: 2px 8px 6px;
    --media-control-background: transparent;
  }

  .watch-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--media-control-height, 2.25rem);
    min-height: var(--media-control-height, 2.25rem);
    padding: 0.25rem;
    color: #fff;
    border-radius: 0.25rem;
    background: transparent;
    transition: background 0.15s ease;
  }

  .watch-icon-button:hover,
  .watch-icon-button:focus-visible,
  .watch-settings-menu-button[aria-expanded="true"] {
    background: rgba(255, 255, 255, 0.12);
  }

  .watch-icon-button svg {
    width: 1.625rem;
    height: 1.5rem;
  }

  .watch-playback-rate-menu-button {
    --media-control-background: transparent;
    --media-control-hover-background: rgba(255, 255, 255, 0.12);
    min-width: 3.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .watch-playback-rate-menu {
    --media-menu-background: rgba(20, 20, 30, 0.95);
    --media-primary-color: #fff;
    --media-menu-border-radius: 0.375rem;
    --media-menu-item-checked-background: rgba(255, 255, 255, 0.15);
  }

  .watch-cast-button[mediacastunavailable],
  .watch-airplay-button[mediaairplayunavailable] {
    display: none;
  }

  .watch-settings-menu-button {
    --media-control-background: transparent;
  }

  .watch-mobile-settings-menu {
    position: absolute;
    right: 0.5rem;
    bottom: 3.25rem;
    z-index: 40;
    min-width: 10rem;
    overflow: hidden;
    border-radius: 0.5rem;
    background: rgba(20, 20, 30, 0.97);
    color: #fff;
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  .watch-mobile-settings-title {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 700;
    border-bottom: 1px solid rgba(255, 255, 255, 0.14);
  }

  .watch-mobile-settings-item {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.55rem 0.75rem;
    font-size: 0.875rem;
    text-align: left;
    background: transparent;
  }

  .watch-mobile-settings-item:hover,
  .watch-mobile-settings-item:focus-visible,
  .watch-mobile-settings-item[aria-checked="true"] {
    background: rgba(255, 255, 255, 0.12);
  }

  .watch-description-collapsed {
    max-height: 6.5rem;
    overflow: hidden;
  }

  @media (min-width: 640px) {
    .watch-seekbar-row {
      padding: 0 16px;
    }
    .watch-media-control-bar {
      padding: 2px 12px 8px;
    }
  }

  .watch-live-moq-shell {
    --media-control-background: transparent;
    --media-control-color: #ffffff;
  }

  .watch-live-moq-controls-container {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 20;
    background: linear-gradient(
      to top,
      rgba(0, 0, 0, 0.9) 0%,
      rgba(0, 0, 0, 0.5) 60%,
      transparent 100%
    );
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }

  .watch-live-moq-shell:hover .watch-live-moq-controls-container,
  .watch-live-moq-shell:focus-within .watch-live-moq-controls-container {
    opacity: 1;
    pointer-events: auto;
  }

  .watch-live-moq-control-bar {
    position: relative;
    z-index: 20;
    padding: 2px 8px 8px;
    --media-control-background: transparent;
  }

  .watch-live-moq-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    min-height: 2.25rem;
    padding: 0.25rem;
    color: #fff;
    border-radius: 0.25rem;
    transition: background 0.15s ease;
  }

  .watch-live-moq-icon-btn:hover,
  .watch-live-moq-icon-btn:focus-visible {
    background: rgba(255, 255, 255, 0.12);
  }

  .watch-live-moq-live-edge-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.5rem;
    margin-left: 0.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #fecdd3;
    border-radius: 0.25rem;
    transition: background 0.15s ease;
  }

  .watch-live-moq-live-edge-btn:hover,
  .watch-live-moq-live-edge-btn:focus-visible {
    background: rgba(244, 63, 94, 0.25);
  }

  .watch-live-moq-volume {
    width: 4.5rem;
    max-width: 22vw;
    height: 0.25rem;
    margin: 0 0.25rem;
    cursor: pointer;
    accent-color: #3b82f6;
    vertical-align: middle;
  }

  @media (min-width: 640px) {
    .watch-live-moq-volume {
      width: 5.5rem;
    }
    .watch-live-moq-control-bar {
      padding: 2px 12px 10px;
    }
  }
</style>
