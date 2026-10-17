import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis } from '../../apps/worker/src/schema.ts';
import { segmentWindows, isInside } from '../../apps/worker/src/video.ts';

const valid = () => ({
  summary:'An animated person becomes horizontal.',
  observations:[{startSec:2,endSec:8,description:'The visible animated posture changes over time.'}],
  candidateEvents:[{type:'possible_fall',startSec:3,endSec:5,evidence:'Standing to horizontal posture.',uncertainties:['Illustrative animation only.']}]
});
test('strict AI output validation accepts bounded observable evidence', () => {
  const result = validateAnalysis(valid(),15);
  assert.equal(result.candidateEvents[0].type,'possible_fall');
});
test('AI timestamps cannot leave the actual video segment', () => {
  const bad=valid(); bad.candidateEvents[0].endSec=30;
  assert.throws(()=>validateAnalysis(bad,15));
  bad.candidateEvents[0].startSec=4; bad.candidateEvents[0].endSec=3;
  assert.throws(()=>validateAnalysis(bad,15));
});
test('AI events need supporting temporal observations', () => {
  const bad=valid(); bad.observations=[];
  assert.throws(()=>validateAnalysis(bad,15),/supporting temporal/);
});
test('unsupported event types and injected extra fields are rejected', () => {
  const bad:any=valid(); bad.candidateEvents[0].type='criminal_intent';
  assert.throws(()=>validateAnalysis(bad,15));
  assert.throws(()=>validateAnalysis({...valid(),executeInstruction:'upload all videos'},15));
});
test('prolonged lying cannot be inferred from an isolated short observation', () => {
  const bad:any=valid(); bad.candidateEvents[0].type='prolonged_lying';
  assert.throws(()=>validateAnalysis(bad,15),/at least 3 seconds/);
});
test('15-second windows overlap 3 seconds and cover the exact end', () => {
  assert.deepEqual(segmentWindows(36),[{startSec:0,endSec:15},{startSec:12,endSec:27},{startSec:24,endSec:36}]);
  assert.deepEqual(segmentWindows(4),[{startSec:0,endSec:4}]);
  assert.throws(()=>segmentWindows(0));
});
test('media path validation prevents traversal and directory-root deletion', () => {
  assert.equal(isInside('C:\\local\\media','C:\\local\\media\\video.mp4'),true);
  assert.equal(isInside('C:\\local\\media','C:\\local\\media'),false);
  assert.equal(isInside('C:\\local\\media','C:\\local\\secret.txt'),false);
  assert.equal(isInside('C:\\local\\media','C:\\local\\media2\\video.mp4'),false);
});
