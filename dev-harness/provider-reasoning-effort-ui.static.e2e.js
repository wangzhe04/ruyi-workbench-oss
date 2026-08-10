'use strict';
// Keep thinking effort with the engine/model switcher, not in the Provider settings form.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js');
const navigation = fs.readFileSync(path.join(root, 'navigation-controls.js'), 'utf8');
const providers = fs.readFileSync(path.join(root, 'provider-settings.js'), 'utf8');

assert.match(navigation, /const PROVIDER_REASONING_EFFORTS_UI = \['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'\]/);
assert.match(navigation, /async function setProviderReasoningEffort\(providerId, value\)/);
assert.match(navigation, /const appendProviderEffort = provider => container =>/);
assert.match(navigation, /addGroup\(p\.id,[\s\S]{0,350}appendProviderEffort\(p\)\)/);
assert.match(navigation, /modelMenu\.modelWithEffort/);
assert.doesNotMatch(providers, /provider\.reasoningEffortHint/);
assert.doesNotMatch(providers, /const effort = el\('label', 'check prov-reason'\)/);

console.log('PROVIDER REASONING EFFORT UI STATIC E2E: ALL PASS');
