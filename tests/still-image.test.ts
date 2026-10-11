import { describe, expect, test } from 'bun:test';

import { ALLOWED_IMAGE_TYPES, isStillImageUrl } from '../src/lib/images';

describe('screenshots are still images', () => {
	test('png, jpg, jpeg and webp are', () => {
		for (const url of [
			'https://cdn.hackclub.com/abc/shot.png',
			'https://cdn.hackclub.com/abc/shot.JPG',
			'https://cdn.hackclub.com/abc/shot.jpeg?w=400',
			'https://cdn.hackclub.com/abc/shot.webp'
		]) {
			expect(isStillImageUrl(url)).toBe(true);
		}
	});

	test('gifs, videos and anything unknown are not', () => {
		for (const url of [
			'https://cdn.hackclub.com/abc/shot.gif',
			'https://cdn.hackclub.com/abc/clip.mp4',
			'https://cdn.hackclub.com/abc/clip.webm',
			'https://example.com/screenshot',
			'not a url'
		]) {
			expect(isStillImageUrl(url)).toBe(false);
		}
	});

	test('the picker and the upload no longer offer gif', () => {
		expect(ALLOWED_IMAGE_TYPES as readonly string[]).not.toContain('image/gif');
	});
});
