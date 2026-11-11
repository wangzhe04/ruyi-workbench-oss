'use strict';
// Activated only by these test harnesses in the server's isolated process.
try {
  if (process.env.RUYI_TEST_MEDIA_TIMING_FILE) require('./media-image-timing.cjs').install({ file: process.env.RUYI_TEST_MEDIA_TIMING_FILE });
} catch { /* Unavailable observation must not change server startup or admission. */ }
