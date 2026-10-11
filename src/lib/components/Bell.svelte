<script lang="ts">
	/**
	 * The bell: a looping video of the model turning, baked from it as raw
	 * luminance, and a canvas that quantises each decoded frame through the
	 * field's ramp with the block figure - the dither is live, as it was under
	 * the shader (see $lib/field/bellDither). The video is muted and inline so
	 * it autoplays everywhere, and held on its first frame for anyone who asked
	 * for less motion.
	 *
	 * What does run script is the easter egg: the code, the voice lines, and
	 * the glow they push into the bell while one is playing.
	 */
	import { onMount } from 'svelte';

	import { startBellDither } from '$lib/field/bellDither';

	const KONAMI = [
		'ArrowUp',
		'ArrowUp',
		'ArrowDown',
		'ArrowDown',
		'ArrowLeft',
		'ArrowRight',
		'ArrowLeft',
		'ArrowRight',
		'b',
		'a',
		'Enter'
	];
	const LINES = 10;

	let slot: HTMLDivElement | undefined;
	let video: HTMLVideoElement | undefined;
	let canvas: HTMLCanvasElement | undefined;
	let glow = $state(0);
	let still = $state(false);

	onMount(() => {
		still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const stopDither = video && canvas ? startBellDither(video, canvas) : () => {};
		let unlocked = false;
		let konamiIdx = 0;
		let audio: AudioContext | null = null;
		let analyser: AnalyserNode | null = null;
		let freq: Uint8Array<ArrayBuffer> | null = null;
		const buffers: AudioBuffer[] = [];
		let loading: Promise<void> | null = null;
		let active: AudioBufferSourceNode | null = null;
		let lastLine = -1;
		let raf = 0;

		/* Fetched the first time the code is typed, not with the page: they are
		   three quarters of a megabyte nothing plays until then. */
		const load = () => {
			if (loading) return loading;
			audio = new AudioContext();
			analyser = audio.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.6;
			analyser.connect(audio.destination);
			freq = new Uint8Array(analyser.frequencyBinCount);
			const ctx = audio;
			loading = Promise.all(
				Array.from({ length: LINES }, (_, i) =>
					fetch(`/audio/orb-line-${i + 1}.mp3`)
						.then((r) => r.arrayBuffer())
						.then((buf) => ctx.decodeAudioData(buf))
				)
			).then((decoded) => {
				buffers.push(...decoded);
			});
			return loading;
		};

		/* The glow follows the line's loudness while it plays and decays after.
		   Only runs while there is something to follow. */
		const tick = () => {
			if (active && analyser && freq) {
				analyser.getByteFrequencyData(freq);
				let sum = 0;
				for (let i = 0; i < freq.length; i++) sum += freq[i];
				const avg = sum / freq.length / 255;
				glow += (0.7 + avg * 0.3 - glow) * 0.12;
			} else {
				glow *= 0.92;
			}
			if (active || glow > 0.01) raf = requestAnimationFrame(tick);
			else glow = 0;
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === KONAMI[konamiIdx]) {
				konamiIdx++;
				if (konamiIdx === KONAMI.length) {
					unlocked = true;
					konamiIdx = 0;
					glow = 1;
					cancelAnimationFrame(raf);
					raf = requestAnimationFrame(tick);
					void load();
				}
			} else {
				konamiIdx = e.key === KONAMI[0] ? 1 : 0;
			}
		};

		const onClick = () => {
			if (!unlocked || !audio || !analyser || buffers.length === 0) return;
			if (active) {
				active.onended = null;
				active.stop();
				active = null;
			}
			let pick = Math.floor(Math.random() * buffers.length);
			if (pick === lastLine && buffers.length > 1) pick = (pick + 1) % buffers.length;
			lastLine = pick;
			if (audio.state === 'suspended') void audio.resume();

			const source = audio.createBufferSource();
			source.buffer = buffers[pick];
			source.playbackRate.value = pick === 3 || pick === 5 ? 1.5 : Math.random() < 0.5 ? 0.7 : 1.5;
			source.connect(analyser);
			source.onended = () => {
				if (active === source) active = null;
			};
			active = source;
			glow = 1;
			source.start();
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(tick);
		};

		window.addEventListener('keydown', onKeyDown);
		slot?.addEventListener('click', onClick);

		return () => {
			stopDither();
			window.removeEventListener('keydown', onKeyDown);
			slot?.removeEventListener('click', onClick);
			cancelAnimationFrame(raf);
			active?.stop();
			void audio?.close();
		};
	});
</script>

<div
	bind:this={slot}
	class="model-wrap"
	aria-hidden="true"
	style:filter={glow > 0.01 ? `brightness(${1 + glow * 0.6})` : undefined}
>
	<canvas bind:this={canvas} class="bell" width="264" height="364"></canvas>
	<video
		bind:this={video}
		class="bell-src"
		src="/models/liberty-bell/bell.mp4"
		autoplay={!still}
		loop
		muted
		playsinline
		preload="auto"
		disablepictureinpicture
	></video>
</div>
