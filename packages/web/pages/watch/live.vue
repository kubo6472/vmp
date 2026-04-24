<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import * as Moq from "@moq/lite";
import * as Watch from "@moq/watch";

const canvas = ref<HTMLCanvasElement | null>(null);

let runtime: {
    connection: unknown;
    broadcast: unknown;
    sync: unknown;
    videoSource: unknown;
    videoDecoder: unknown;
    videoRenderer: unknown;
    audioSource: unknown;
    audioDecoder: unknown;
    audioEmitter: unknown;
} | null = null;

onMounted(() => {
    if (!canvas.value) return;

    // A MoQ connection that is automatically re-established on drop.
    const connection = new Moq.Connection.Reload({
        url: new URL("https://cdn.moq.dev/anon"),
        enabled: true,
    });

    // The MoQ broadcast being fetched.
    const broadcast = new Watch.Broadcast({
        connection: connection.established,
        enabled: true,
        name: Moq.Path.from("bbb"),
    });

    // Synchronize audio and video playback.
    const sync = new Watch.Sync();

    // Decode and render video into the page canvas.
    const videoSource = new Watch.Video.Source(sync, { broadcast });
    const videoDecoder = new Watch.Video.Decoder(videoSource);
    const videoRenderer = new Watch.Video.Renderer(videoDecoder, { canvas: canvas.value, paused: false });

    // Decode and emit audio through WebAudio.
    const audioSource = new Watch.Audio.Source(sync, { broadcast });
    const audioDecoder = new Watch.Audio.Decoder(audioSource);
    const audioEmitter = new Watch.Audio.Emitter(audioDecoder, { paused: false });

    runtime = {
        connection,
        broadcast,
        sync,
        videoSource,
        videoDecoder,
        videoRenderer,
        audioSource,
        audioDecoder,
        audioEmitter,
    };
});

onUnmounted(() => {
    // Best-effort cleanup across library versions.
    const instances = runtime ? Object.values(runtime) : [];
    for (const instance of instances) {
        const resource = instance as { close?: () => void; destroy?: () => void; stop?: () => void } | undefined;
        resource?.stop?.();
        resource?.destroy?.();
        resource?.close?.();
    }
    runtime = null;
});
</script>

<template>
    <canvas ref="canvas" class="h-full w-full" />
</template>