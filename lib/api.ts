'use client';

import { SERVER_URL } from './config';
import type { PublicMessage, Sender, SiteConfig, StoredMessage } from './types';

async function request<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const { token, ...rest } = init ?? {};
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? '通信に失敗しました。');
  }
  return data as T;
}

/* -------------------------- 来訪者向け -------------------------- */

export const getSiteConfig = () => request<{ replyEtaDays: number }>('/api/config');

export const sendWrittenMessage = (body: string, sender: Sender = {}) =>
  request<{ token: string; createdAt: number; replyEtaDays: number }>('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ body, sender }),
  });

export const fetchWrittenMessage = (token: string) =>
  request<{ message: PublicMessage; replyEtaDays: number }>(
    `/api/messages/${encodeURIComponent(token)}`,
  );

/* --------------------------- 神父向け --------------------------- */

export const adminLogin = (password: string) =>
  request<{ token: string }>('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });

export const adminMessages = (token: string) =>
  request<{ messages: StoredMessage[]; config: SiteConfig }>('/api/admin/messages', { token });

export const adminMarkRead = (token: string, id: string, read: boolean) =>
  request<{ message: StoredMessage }>(`/api/admin/messages/${id}/read`, {
    method: 'POST',
    token,
    body: JSON.stringify({ read }),
  });

export const adminReply = (token: string, id: string, body: string) =>
  request<{ message: StoredMessage }>(`/api/admin/messages/${id}/reply`, {
    method: 'POST',
    token,
    body: JSON.stringify({ body }),
  });

export const adminDeleteMessage = (token: string, id: string) =>
  request<{ ok: boolean }>(`/api/admin/messages/${id}`, { method: 'DELETE', token });

export const adminUpdateConfig = (token: string, patch: Partial<SiteConfig>) =>
  request<{ config: SiteConfig }>('/api/admin/config', {
    method: 'POST',
    token,
    body: JSON.stringify(patch),
  });
