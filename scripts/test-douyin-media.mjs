import assert from 'node:assert/strict';
import {
  extractDouyinAwemeId,
  extractDouyinMediaCandidates,
} from '../utils/douyin-media-payload.ts';

const currentId = '7649649819564707109';
const nextId = '7649649819564707110';

assert.equal(
  extractDouyinAwemeId(`https://www.douyin.com/video/${currentId}?previous_page=web_code_link`),
  currentId,
);
assert.equal(extractDouyinAwemeId(`https://www.douyin.com/?modal_id=${nextId}`), nextId);

const candidates = extractDouyinMediaCandidates({
  aweme_detail: {
    aweme_id: currentId,
    video: {
      play_addr_h264: {
        url_list: [
          'https://v3-web.douyinvod.com/video/tos/cn/h264.mp4',
          'http://insecure.example/video.mp4',
        ],
      },
      bit_rate: [
        {
          bit_rate: 1000,
          play_addr: { url_list: ['https://v9.douyinvod.com/video/tos/cn/low.mp4'] },
        },
        {
          bit_rate: 3000,
          play_addr: { url_list: ['https://v9.douyinvod.com/video/tos/cn/high.mp4'] },
        },
      ],
      play_addr: { url_list: ['https://v26.douyinvod.com/video/tos/cn/default.mp4'] },
      download_addr: { url_list: ['https://v26.douyinvod.com/video/tos/cn/watermark.mp4'] },
    },
  },
});

assert.equal(candidates[0]?.awemeId, currentId);
assert.equal(candidates[0]?.sourceField, 'play_addr_h264');
assert.equal(candidates[0]?.priority, 120);
assert.ok(
  candidates.findIndex((item) => item.url.endsWith('/high.mp4')) <
    candidates.findIndex((item) => item.url.endsWith('/low.mp4')),
);
assert.ok(!candidates.some((item) => item.url.startsWith('http://')));

const feedCandidates = extractDouyinMediaCandidates({
  aweme_list: [
    {
      aweme_id: currentId,
      video: { play_addr: { url_list: ['https://v1.douyinvod.com/video/current.mp4'] } },
    },
    {
      aweme_id: nextId,
      video: { play_addr: { url_list: ['https://v1.douyinvod.com/video/next.mp4'] } },
    },
  ],
});

assert.equal(feedCandidates.filter((item) => item.awemeId === currentId).length, 1);
assert.equal(feedCandidates.filter((item) => item.awemeId === nextId).length, 1);

console.log('douyin media payload tests passed');
