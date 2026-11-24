import { describe, expect, it } from '@jest/globals';
import { diagnoseEmptyProviderRun } from '../services/workflow/providerDatasetResults.js';

describe('JustDial empty-run diagnostics', () => {
  it.each([
    'Free user call limit reached. Please upgrade to a paying user to use this actor.',
    'Free user run limit exceeded. Maximum 3 runs allowed. Please upgrade to a paying user to use this actor.',
  ])('does not misclassify an actor plan refusal as a no-match result', log => {
    expect(diagnoseEmptyProviderRun('powerai/facebook-post-search-scraper', log))
      .toContain('actor plan limit prevented execution');
  });
  it('distinguishes a rejected LinkedIn posts target from genuine inactivity', () => {
    expect(diagnoseEmptyProviderRun('harvestapi/linkedin-profile-posts',
      'Error scraping item#1 {"targetUrl":"https://www.linkedin.com/in/ACwExample"}: "No valid target provided"\nPosts found 0'))
      .toContain('provider rejected the profile URL');
    expect(diagnoseEmptyProviderRun('harvestapi/linkedin-profile-posts', 'Posts found 0. Progress: 1/1')).toBeNull();
  });
  it('does not label an unreadable skipped listing as a verified no-match result', () => {
    expect(diagnoseEmptyProviderRun('memo23/justdial-business-scraper',
      'WARN [LISTING] page=1 rendered but no listData — stopping\nrows=0 listings=0 skipped=1'))
      .toContain('No matches could be verified');
  });
  it('preserves an ordinary empty result with no provider-failure evidence', () => {
    expect(diagnoseEmptyProviderRun('memo23/justdial-business-scraper', 'rows=0 listings=1 skipped=0')).toBeNull();
  });
  it('does not infer a failure from an unavailable log or a different actor', () => {
    expect(diagnoseEmptyProviderRun('memo23/justdial-business-scraper', undefined)).toBeNull();
    expect(diagnoseEmptyProviderRun('other/actor', '[LISTING] no listData')).toBeNull();
  });
});
