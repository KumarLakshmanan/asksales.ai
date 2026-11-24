import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialPublisher } from '@/components/social-publishing/SocialPublisher';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
  accounts: [] as Array<Record<string, unknown>>,
  loading: false,
  error: null as string | null,
}));

vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useOrganicPublishingAccounts', () => ({
  useOrganicPublishingAccounts: () => ({
    accounts: mocks.accounts,
    loading: mocks.loading,
    error: mocks.error,
    connectedPlatforms: ['instagram', 'facebook'].filter((platform) => mocks.accounts.some((account) => account.platform === platform)),
    forPlatform: (platform: string) => mocks.accounts.filter((account) => account.platform === platform),
    preferredForPlatform: (platform: string) => {
      const available = mocks.accounts.filter((account) => account.platform === platform);
      return available.find((account) => account.isSelected) || (available.length === 1 ? available[0] : undefined);
    },
  }),
}));

describe('SocialPublisher', () => {
  it('shows Instagram limits and blocks more than thirty reviewed hashtags', async () => {
    mocks.accounts = [{ credentialId: 11, platform: 'instagram', accountName: 'Launch profile', isSelected: true }];
    render(<SocialPublisher assetId={41} open onOpenChange={vi.fn()} />);
    const caption = await screen.findByLabelText('Caption');
    fireEvent.change(caption, { target: { value: Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(' ') } });
    expect(screen.getByText('Instagram captions support at most 30 hashtags.')).toBeVisible();
    expect(screen.getByText(/31 \/ 30 hashtags/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Publish post' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('polls the exact child attempt and replaces processing with confirmed publication', async () => {
    mocks.accounts = [{ credentialId: 70, platform: 'youtube', accountName: 'Video channel', isSelected: true }];
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences') ? { timezone: 'Asia/Kolkata' } : path.endsWith('/publish-attempts') ? { attempts: [{ id: 82, platform: 'youtube', status: 'succeeded', providerPostUrl: 'https://youtube.com/watch?v=published' }] } : { id: 700, version: 1, publishingReviewToken: 'fixture-review', type: 'video', title: 'Saved title', content: 'Description', videoUrl: '/uploads/video.mp4', metadata: { youtubeOptions: { madeForKids: false, containsSyntheticMedia: false } } }));
    mocks.post.mockResolvedValue({ accepted: true, results: { youtube: { success: false, status: 'provider_succeeded', attemptId: 82, assetId: 701 } } });
    let tick: (() => void) | undefined;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback) => { tick = callback as () => void; return 123 as unknown as ReturnType<typeof window.setInterval>; });
    try {
      render(<SocialPublisher assetId={700} open onOpenChange={vi.fn()} />);
      const publish = await screen.findByRole('button', { name: 'Publish post' });
      await waitFor(() => expect(publish).toBeEnabled()); fireEvent.click(publish);
      await screen.findByText('Publishing in progress');
      expect(screen.queryByRole('button', { name: 'Review again' })).not.toBeInTheDocument();
      await act(async () => { tick?.(); });
      expect(mocks.get).toHaveBeenCalledWith('/api/content/assets/701/publish-attempts');
      expect(await screen.findByText('Post published')).toBeVisible();
      expect(screen.getByRole('link', { name: 'View status in calendar' })).toHaveAttribute('href', '/dashboard/content-calendar');
    } finally { interval.mockRestore(); }
  });
  it('hydrates and sends a reviewed YouTube video with channel-specific options', async () => {
    mocks.accounts = [{ credentialId: 70, platform: 'youtube', accountName: 'Video channel', isSelected: true }];
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences') ? { timezone: 'UTC' } : {
      id: 700, version: 1, publishingReviewToken: 'fixture-review', type: 'video', title: 'Saved title', content: JSON.stringify({ description: 'Reviewed description' }), videoUrl: '/uploads/video.mp4',
      metadata: { privacyStatus: 'unlisted', tags: ['demo'], youtubeOptions: { madeForKids: false, containsSyntheticMedia: true, categoryId: '27' } },
    }));
    mocks.post.mockResolvedValue({ accepted: true, results: { youtube: { success: true, status: 'provider_succeeded' } } });
    render(<SocialPublisher assetId={700} open initialPlatform="youtube" onOpenChange={vi.fn()} />);
    expect(await screen.findByLabelText('YouTube video title')).toHaveValue('Saved title');
    expect(screen.getByLabelText('YouTube description')).toHaveValue('Reviewed description');
    const publish = screen.getByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ expectedVersion: 1, expectedReviewToken: 'fixture-review', targets: [{ platform: 'youtube', credentialId: 70, title: 'Saved title', caption: 'Reviewed description', privacyStatus: 'unlisted', tags: ['demo'], youtubeOptions: { madeForKids: false, containsSyntheticMedia: true, categoryId: '27' } }] });
    expect(await screen.findByText('Publishing in progress')).toBeVisible();
  });
  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mocks.accounts = [];
    mocks.loading = false;
    mocks.error = null;
    mocks.get.mockResolvedValue({ id: 41, version: 1, publishingReviewToken: 'fixture-review', title: 'Launch', content: JSON.stringify({ caption: 'Launch day' }), channel: 'instagram', imageUrl: '/uploads/launch.jpg' });
    mocks.post.mockResolvedValue({ success: true, results: { instagram: { success: true, status: 'succeeded' }, facebook: { success: true, status: 'succeeded' } } });
  });

  it('shows a connection action instead of disconnected destination controls', async () => {
    render(<SocialPublisher assetId={41} open onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Connect a publishing account')).toBeVisible();
    expect(screen.getByRole('link', { name: /Connect social accounts/ })).toHaveAttribute('href', '/dashboard/integrations');
    expect(screen.queryByText('Instagram account')).not.toBeInTheDocument();
  });

  it('shows only connected destinations and uses the integration default account', async () => {
    mocks.accounts = [
      { credentialId: 10, platform: 'instagram', accountName: 'Old profile', providerAccountId: 'ig-1', isSelected: false },
      { credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', isSelected: true },
      { credentialId: 20, platform: 'facebook', accountName: 'Launch Page', providerAccountId: 'fb-1', isSelected: true },
    ];
    render(<SocialPublisher assetId={41} open onOpenChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Instagram Launch profile' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Facebook Launch Page' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Launch profile · Default')).toBeInTheDocument());
  });

  it('submits Facebook and Instagram with independent reviewed settings', async () => {
    mocks.accounts = [
      { credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', isSelected: true },
      { credentialId: 20, platform: 'facebook', accountName: 'Launch Page', providerAccountId: 'fb-1', isSelected: true },
    ];
    render(<SocialPublisher assetId={41} open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Instagram Launch profile' });
    fireEvent.click(screen.getByRole('button', { name: /Facebook Launch Page/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Different caption for each network/ }));
    fireEvent.change(screen.getByLabelText('Facebook caption'), { target: { value: 'Facebook-specific launch copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    const payload = mocks.post.mock.calls[0][1] as { targets: Array<Record<string, unknown>> };
    expect(payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'instagram', credentialId: 11, caption: 'Launch day', postType: 'post' }),
      expect.objectContaining({ platform: 'facebook', credentialId: 20, caption: 'Facebook-specific launch copy', postType: 'photo' }),
    ]));
  });

  it('distinguishes an account loading failure from a disconnected account', async () => {
    mocks.error = 'Connection lookup failed';
    render(<SocialPublisher assetId={41} open onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Publishing accounts unavailable')).toBeVisible();
    expect(screen.getByText('Connection lookup failed')).toBeVisible();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeVisible();
  });

  it('retries the original uncertain request and only reviews changed copy after an empty receipt lookup', async () => {
    mocks.accounts = [{ credentialId: 20, platform: 'facebook', accountName: 'Launch Page', isSelected: true }];
    mocks.get.mockResolvedValue({id:401,version:1,publishingReviewToken:'fixture-review',title:'Launch',content:'Reviewed copy',status:'draft'});
    mocks.post.mockRejectedValue(new Error('Response interrupted'));
    render(<SocialPublisher assetId={401} open onOpenChange={vi.fn()} />);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    expect(await screen.findByRole('alert')).toHaveTextContent('retry unchanged settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry original request' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[0][2]).toEqual(mocks.post.mock.calls[1][2]);
    mocks.get.mockResolvedValueOnce({attempts:[]});
    fireEvent.click(screen.getByRole('button',{name:'Check previous request'}));
    fireEvent.click(await screen.findByRole('button',{name:'Review latest draft'}));
    const revised=await screen.findByRole('button',{name:'Publish post'});await waitFor(()=>expect(revised).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: 'Changed reviewed copy' } });
    fireEvent.click(revised);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    expect(mocks.post.mock.calls[2][2]).not.toEqual(mocks.post.mock.calls[0][2]);
  });

  it('preserves CTA/hashtags in the review and distinguishes failure from success', async () => {
    mocks.accounts = [{ credentialId: 20, platform: 'facebook', accountName: 'Launch Page', isSelected: true }];
    mocks.get.mockResolvedValue({ id: 402, version: 1, publishingReviewToken: 'fixture-review', title: 'Launch', content: JSON.stringify({ caption: 'Launch', cta: 'Learn more', hashtags: ['Launch'] }) });
    mocks.post.mockResolvedValue({ success: false, results: { facebook: { success: false, error: 'Provider rejected this post' } } });
    const onPublished = vi.fn();
    render(<SocialPublisher assetId={402} open onOpenChange={vi.fn()} onPublished={onPublished} />);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    expect(screen.getByLabelText('Caption')).toHaveValue('Launch\n\nLearn more\n\n#Launch');
    fireEvent.click(publish);
    expect(await screen.findByText('Publishing failed')).toBeVisible();
    expect(onPublished).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Publishing failed', variant: 'destructive' }));
  });

  it('resets custom copy and scheduling when another asset is opened', async () => {
    mocks.accounts = [{ credentialId: 20, platform: 'facebook', accountName: 'Launch Page', isSelected: true }];
    const view = render(<SocialPublisher assetId={403} open onOpenChange={vi.fn()} />);
    await screen.findByLabelText('Caption');
    fireEvent.click(screen.getByRole('switch', { name: /Different caption for each network/ }));
    fireEvent.change(screen.getByLabelText('Facebook caption'), { target: { value: 'Old override' } });
    fireEvent.click(screen.getAllByRole('switch')[1]);
    expect(screen.getByRole('button', { name: 'Schedule post' })).toBeVisible();
    mocks.get.mockResolvedValue({ id: 404, version: 1, publishingReviewToken: 'fixture-review', title: 'Second', content: 'Second caption', channel: 'facebook' });
    view.rerender(<SocialPublisher assetId={404} open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Caption')).toHaveValue('Second caption'));
    expect(screen.getByRole('switch', { name: /Different caption for each network/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Publish post' })).toBeVisible();
  });

  it('prevents duplicate submission and editing while publishing is pending', async () => {
    mocks.accounts = [{ credentialId: 20, platform: 'facebook', accountName: 'Launch Page', isSelected: true }];
    mocks.post.mockImplementation(() => new Promise(() => {}));
    render(<SocialPublisher assetId={405} open onOpenChange={vi.fn()} />);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish); fireEvent.click(publish);
    expect(publish).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Caption')).toBeDisabled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('shows accepted processing as pending rather than a published confirmation', async () => {
    mocks.accounts = [{ credentialId: 20, platform: 'facebook', accountName: 'Launch Page', isSelected: true }];
    mocks.post.mockResolvedValue({ success: false, accepted: true, results: { facebook: { success: false, status: 'pending' } } });
    render(<SocialPublisher assetId={406} open onOpenChange={vi.fn()} />);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    expect(await screen.findByText('Publishing in progress')).toBeVisible();
    expect(screen.queryByText('Post published')).not.toBeInTheDocument();
  });

  it('uses one modal scroll region and shows settings for every selected destination', async () => {
    mocks.accounts = [
      { credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', isSelected: true },
      { credentialId: 20, platform: 'facebook', accountName: 'Launch Page', providerAccountId: 'fb-1', isSelected: true },
    ];
    render(<SocialPublisher assetId={407} open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Instagram Launch profile' });
    fireEvent.click(screen.getByRole('button', { name: 'Facebook Launch Page' }));
    expect(screen.getByTestId('social-publisher-scroll-region')).toHaveClass('overflow-y-auto');
    expect(screen.getByRole('region', { name: 'Instagram destination settings' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Facebook destination settings' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Instagram destination settings' })).toHaveTextContent('Launch profile');
    expect(screen.queryByRole('combobox', { name: 'Instagram connected account' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Facebook destination settings' })).toHaveTextContent('Launch Page');
    expect(screen.queryByRole('combobox', { name: 'Facebook connected account' })).not.toBeInTheDocument();
    expect(screen.queryByText('Active settings')).not.toBeInTheDocument();
  });

  it('keeps other network captions when Instagram Story is selected', async () => {
    mocks.accounts = [
      { credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', isSelected: true },
      { credentialId: 20, platform: 'facebook', accountName: 'Launch Page', providerAccountId: 'fb-1', isSelected: true },
    ];
    render(<SocialPublisher assetId={408} open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Instagram Launch profile' });
    fireEvent.click(screen.getByRole('button', { name: 'Facebook Launch Page' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Instagram publishing format' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Instagram Story · no caption' }));
    expect(screen.getByRole('switch', { name: /Different caption for each network/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
    expect(screen.getByLabelText('Instagram caption')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Facebook' }));
    expect(screen.getByLabelText('Facebook caption')).toHaveValue('Launch day');
  });

  it('shows the exact account-timezone instant before scheduling', async () => {
    mocks.accounts = [{ credentialId: 11, platform: 'instagram', accountName: 'Launch profile', providerAccountId: 'ig-2', isSelected: true }];
    mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('preferences')
      ? { timezone: 'Asia/Kolkata' }
      : { id: 409, version: 1, publishingReviewToken: 'fixture-review', title: 'Launch', content: 'Launch day', channel: 'instagram', imageUrl: '/uploads/launch.jpg' }));
    render(<SocialPublisher assetId={409} open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Instagram Launch profile' });
    fireEvent.click(screen.getByRole('switch', { name: 'Schedule for later' }));
    fireEvent.change(screen.getByLabelText('Scheduled date and time'), { target: { value: '2099-09-18T16:45' } });
    expect(await screen.findByText(/Sep 18, 2099, 4:45 PM GMT\+5:30/)).toBeVisible();
    expect(screen.getByText('Change account timezone')).toHaveAttribute('href', '/dashboard/settings/preferences');
  });
  it('recovers the original success receipt after server normalization and remount without a new POST', async () => {
    mocks.accounts=[{credentialId:20,platform:'facebook',accountName:'Synthetic Page',isSelected:true}];
    let normalized=false;
    mocks.get.mockImplementation(async(path:string)=>path.includes('preferences')?{timezone:'UTC'}:path.includes('/publish-attempts')?{attempts:[{id:71,assetId:409,platform:'facebook',status:'succeeded',idempotencyKey:`${mocks.post.mock.calls[0][2].headers['Idempotency-Key']}:facebook`,providerPostId:'synthetic-post',providerPostUrl:'https://example.invalid/synthetic-post'}]}:{id:409,version:1,publishingReviewToken:normalized?'normalized-source':'original-source',title:'Synthetic post',content:normalized?JSON.stringify({content:'Reviewed copy',caption:'Reviewed copy'}):'Reviewed copy',status:normalized?'published':'draft'});
    mocks.post.mockRejectedValue(new Error('Synthetic accepted response lost'));
    const view=render(<SocialPublisher assetId={409} open onOpenChange={vi.fn()}/>);const button=await screen.findByRole('button',{name:'Publish post'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);await screen.findByText(/Synthetic accepted response lost/);view.unmount();normalized=true;mocks.accounts=[];mocks.error='Synthetic account enumeration outage';
    render(<SocialPublisher assetId={409} open onOpenChange={vi.fn()}/>);
    expect(await screen.findByText('Post published')).toBeVisible();expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('/api/content/assets/409/publish-attempts',{params:{requestKey:mocks.post.mock.calls[0][2].headers['Idempotency-Key']}});
  });
  it('only explicitly retries the original exact request if receipt lookup finds no attempt', async () => {
    mocks.accounts=[{credentialId:20,platform:'facebook',accountName:'Synthetic Page',isSelected:true}];
    let normalized=false;
    mocks.get.mockImplementation(async(path:string)=>path.includes('preferences')?{timezone:'UTC'}:path.includes('/publish-attempts')?{attempts:[]}:{id:410,version:1,publishingReviewToken:normalized?'normalized-source':'original-source',title:'Synthetic post',content:'Reviewed copy',status:'draft'});
    mocks.post.mockRejectedValueOnce(new Error('Synthetic response interrupted')).mockResolvedValueOnce({success:true,results:{facebook:{success:true,status:'succeeded',attemptId:72,assetId:410}}});
    const view=render(<SocialPublisher assetId={410} open onOpenChange={vi.fn()}/>);const button=await screen.findByRole('button',{name:'Publish post'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);await screen.findByText(/Synthetic response interrupted/);const original=mocks.post.mock.calls[0];view.unmount();normalized=true;
    render(<SocialPublisher assetId={410} open onOpenChange={vi.fn()}/>);const retry=await screen.findByRole('button',{name:'Retry original request'});expect(mocks.post).toHaveBeenCalledTimes(1);fireEvent.click(retry);await screen.findByText('Post published');expect(mocks.post.mock.calls[1]).toEqual(original);
  });

});
