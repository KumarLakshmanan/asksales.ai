import { describe, expect, it } from 'vitest';
import { rankAds } from '@/lib/adPerformanceRanking';
const now = Date.parse('2026-09-09T12:00:00Z');
const ad = (id:string,leads:number|null,spend:number, platform='meta', measurementWindow='7 days') => ({targetType:'ad',targetKey:id,platform,measurementWindow,metricsUpdatedAt:'2026-09-09T11:00:00Z',aggregate:{leads,conversions:100,spend,impressions:1000}});
describe('descriptive ad rankings', () => {
  it('ranks by actual leads then CPL and preserves zero leads', () => {
    const rows=rankAds([ad('expensive',8,80),ad('zero',0,40),ad('efficient',8,40),ad('winner',10,100),ad('unknown',null,20)],'leads',now);
    expect(rows.map(row=>row.ad.targetKey)).toEqual(['winner','efficient','expensive','zero','unknown']);
    expect(rows.map(row=>row.rank)).toEqual([1,2,3,4,null]);
    expect(rows[3].result).toBe(0);expect(rows[3].costPerResult).toBeNull();
  });
  it('does not compare platforms or reporting windows and excludes stale or undelivered ads', () => {
    const rows=rankAds([ad('meta',8,40),ad('google',5,40,'google'),ad('window',3,40,'meta','90 days'),{...ad('stale',90,10),metricsUpdatedAt:'2026-08-01'}, {...ad('no-delivery',99,1),aggregate:{leads:99,spend:1,impressions:0}}],'leads',now);
    for(const id of ['meta','google','window']) expect(rows.find(row=>row.ad.targetKey===id)?.rank).toBe(1);
    expect(rows.find(row=>row.ad.targetKey==='stale')?.rank).toBeNull();
    expect(rows.find(row=>row.ad.targetKey==='no-delivery')?.rank).toBeNull();
  });
});

it('uses CPM per thousand impressions for awareness instead of spend divided by reach', () => {
  const [row] = rankAds([{...ad('awareness',null,255), aggregate:{spend:255,impressions:100000,reach:80000}}], 'awareness', now);
  expect(row).toMatchObject({result:80000,costLabel:'CPM',costPerResult:2.55,resultLabel:'Reach'});
});
it.each([['traffic','clicks','CPC'],['engagement','engagements','CPE'],['app_promotion','installs','CPI'],['sales','conversions','CPA'],['conversations','conversions','Cost / conversation']])('ranks %s by its own outcome', (objective,metric,costLabel) => {
  const [row]=rankAds([{...ad('objective',null,60),aggregate:{spend:60,impressions:2000,[metric]:3}}],objective,now);
  expect(row).toMatchObject({result:3,costLabel,costPerResult:20});
});
