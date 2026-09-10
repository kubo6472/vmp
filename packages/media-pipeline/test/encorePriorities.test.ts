import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENCORE_JOB_PRIORITY,
  encoreQueueForPriority,
} from '../encorePriorities.js';

describe('encorePriorities', () => {
  it('maps fast-lane to high queue and ladder/podcast to low queue', () => {
    assert.equal(encoreQueueForPriority(ENCORE_JOB_PRIORITY.FAST_LANE_720P), 0);
    assert.equal(encoreQueueForPriority(ENCORE_JOB_PRIORITY.RENDITION_720P), 0);
    assert.equal(encoreQueueForPriority(ENCORE_JOB_PRIORITY.FULL_LADDER), 1);
    assert.equal(encoreQueueForPriority(ENCORE_JOB_PRIORITY.PODCAST), 1);
    assert.equal(encoreQueueForPriority(ENCORE_JOB_PRIORITY.PREVIEW_MP3), 1);
    assert.equal(encoreQueueForPriority(ENCORE_JOB_PRIORITY.RENDITION_OTHER), 1);
  });

  it('uses priority 50 as the high-queue boundary', () => {
    assert.equal(encoreQueueForPriority(50), 0);
    assert.equal(encoreQueueForPriority(49), 1);
  });
});
