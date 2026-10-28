import test from 'node:test';import assert from 'node:assert/strict';import {matchesFollowUp as match} from '../src/followUps.ts';
const now=Date.parse('2026-10-23T20:00Z');
test('IST today starts before UTC midnight',()=>{assert.equal(match({follow_up_at:'2026-10-23T19:00Z'},'today',now),true);assert.equal(match({follow_up_at:'2026-10-23T18:29Z'},'today',now),false)});
test('overdue, upcoming, completed and absent',()=>{const lead={follow_up_at:'2026-10-23T19:00Z'};assert.equal(match(lead,'overdue',now),true);assert.equal(match(lead,'upcoming',now),false);assert.equal(match({...lead,follow_up_done:true},'overdue',now),false);assert.equal(match({...lead,follow_up_done:true},'completed',now),true);assert.equal(match({},'pending',now),false)});
