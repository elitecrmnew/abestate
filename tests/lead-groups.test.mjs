import test from 'node:test';import assert from 'node:assert/strict';import {groupCards} from '../src/leadGroups.ts';
const groups=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'},{id:'c',name:'Empty'}];
const now=Date.parse('2026-10-16T03:00:00Z');
const leads=[{group_id:'a',created_at:'2026-10-15T18:29:00Z',assigned_at:'2026-10-15T18:29:00Z'},{group_id:'b',created_at:'2026-10-14T00:00:00Z',assigned_at:'2026-10-15T18:30:00Z'}];
test('caller groups exclude empty and sort new assignments first at IST midnight',()=>{const x=groupCards(groups,leads,false,now);assert.deepEqual(x.map(g=>g.id),['b','a']);assert.equal(x[0].newToday,1);assert.equal(x[1].newToday,0)});
test('admin badges use import date and retain empty groups',()=>{const x=groupCards(groups,leads,true,now);assert.equal(x.length,3);assert.equal(x.reduce((n,g)=>n+g.newToday,0),0)});
test('invalid assignment dates do not count as new',()=>assert.equal(groupCards(groups,[{...leads[0],assigned_at:null}],false,now)[0].newToday,0));
