'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { aiVisibilityApi, type AiVisibilityCmsPlatform } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { refreshVisibility, useMeasurement } from './workspace-context';
import { InlineError } from './workspace-ui';
export function CmsConnections({
  projectId,
  catalogOnly = false,
}: {
  projectId: number;
  catalogOnly?: boolean;
}) {
  const { can } = useMeasurement();
  const client = useQueryClient();
  const [platform, setPlatform] = useState<AiVisibilityCmsPlatform>();
  const [fields, setFields] = useState({
    siteUrl: '',
    username: '',
    applicationPassword: '',
    storeDomain: '',
    accessToken: '',
    blogId: '',
    authorName: '',
  });
  const query = useQuery({
    queryKey: ['ai-visibility-cms-connections', projectId],
    queryFn: () => aiVisibilityApi.cmsConnections(projectId),
  });
  const save = useMutation({
    mutationFn: () =>
      platform === 'wordpress'
        ? aiVisibilityApi.saveCmsConnection(projectId, {
            platform,
            siteUrl: fields.siteUrl,
            username: fields.username,
            applicationPassword: fields.applicationPassword,
          })
        : aiVisibilityApi.saveCmsConnection(projectId, {
            platform: 'shopify',
            storeDomain: fields.storeDomain,
            accessToken: fields.accessToken,
            blogId: fields.blogId || undefined,
            authorName: fields.authorName || undefined,
          }),
    onSuccess: () => {
      setPlatform(undefined);
      setFields({
        siteUrl: '',
        username: '',
        applicationPassword: '',
        storeDomain: '',
        accessToken: '',
        blogId: '',
        authorName: '',
      });
      refreshVisibility(client, projectId);
    },
  });
  const disconnect = useMutation({
    mutationFn: (value: AiVisibilityCmsPlatform) =>
      aiVisibilityApi.deleteCmsConnection(projectId, value),
    onSuccess: () => refreshVisibility(client, projectId),
  });
  if (query.isError)
    return (
      <InlineError
        message="Connection status could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  const platforms: AiVisibilityCmsPlatform[] = catalogOnly ? ['shopify'] : ['wordpress', 'shopify'];
  return (
    <section
      className="space-y-3"
      aria-label={catalogOnly ? 'Catalog connection' : 'CMS connections'}
    >
      <div className="divide-y">
        {platforms.map((value) => {
          const current = query.data?.connections.find((item) => item.platform === value);
          return (
            <div
              key={value}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <div>
                <h3 className="font-medium capitalize">{value}</h3>
                <p className="text-xs text-muted-foreground">
                  {query.isLoading
                    ? 'Loading connection…'
                    : current?.connected
                      ? `${current.accountLabel || current.storeDomain || current.siteUrl} · ${current.publishingReady ? 'Publishing destination ready' : 'Catalog connected; blog settings needed for articles'}`
                      : 'Not connected'}
                </p>
              </div>
              {can.connections && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={query.isLoading}
                    onClick={() => {
                      setFields({
                        siteUrl: current?.siteUrl || '',
                        username: '',
                        applicationPassword: '',
                        storeDomain: current?.storeDomain || '',
                        accessToken: '',
                        blogId: '',
                        authorName: '',
                      });
                      setPlatform(value);
                    }}
                  >
                    {current?.connected ? 'Update connection' : 'Connect'}
                  </Button>
                  {current?.connected && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate(value)}
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!can.connections && (
        <p className="text-xs text-muted-foreground">
          The workspace owner manages external connections.
        </p>
      )}
      {platform && (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <h3 className="font-medium">
            Connect {platform === 'wordpress' ? 'WordPress' : 'Shopify'}
          </h3>
          <p className="text-xs text-muted-foreground">
            Credentials are verified and encrypted. Shopify catalog setup requires the store domain
            and access token; blog settings are optional until creating article drafts.
          </p>
          {(platform === 'wordpress'
            ? [
                {
                  key: 'siteUrl' as const,
                  label: 'Site URL',
                  type: 'url',
                  required: true,
                },
                {
                  key: 'username' as const,
                  label: 'Username',
                  type: 'text',
                  required: true,
                },
                {
                  key: 'applicationPassword' as const,
                  label: 'Application password',
                  type: 'password',
                  required: true,
                },
              ]
            : [
                {
                  key: 'storeDomain' as const,
                  label: 'Permanent store domain',
                  type: 'text',
                  required: true,
                },
                {
                  key: 'accessToken' as const,
                  label: 'Admin API access token',
                  type: 'password',
                  required: true,
                },
                {
                  key: 'blogId' as const,
                  label: 'Blog ID (optional for catalog)',
                  type: 'text',
                  required: Boolean(fields.authorName),
                },
                {
                  key: 'authorName' as const,
                  label: 'Article author (optional for catalog)',
                  type: 'text',
                  required: Boolean(fields.blogId),
                },
              ]
          ).map((field) => (
            <label key={field.key} className="block text-sm">
              {field.label}
              <Input
                type={field.type}
                value={fields[field.key]}
                required={field.required}
                autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
          <div className="flex gap-2">
            <Button size="sm" disabled={!can.connections || save.isPending}>
              {save.isPending ? 'Verifying…' : 'Verify and save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setPlatform(undefined);
                setFields({
                  siteUrl: '',
                  username: '',
                  applicationPassword: '',
                  storeDomain: '',
                  accessToken: '',
                  blogId: '',
                  authorName: '',
                });
              }}
            >
              Cancel
            </Button>
          </div>
          {save.isError && (
            <InlineError message={save.error.message} onRetry={() => save.mutate()} />
          )}
        </form>
      )}
      {disconnect.isError && <InlineError message={disconnect.error.message} />}
    </section>
  );
}
