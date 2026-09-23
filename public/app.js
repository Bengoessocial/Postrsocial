/**
 * Postr Social (postrsocial.app)
 * Modern, mobile-first Progressive Web App powered by AT Protocol (@atproto/api)
 * Standalone ESM implementation for direct browser & PWA execution.
 */

import { BskyAgent } from 'https://esm.sh/@atproto/api@0.14.8';

// ==========================================
// Configuration & Constants
// ==========================================
// Default PDS service endpoint is hardcoded to https://postrsocial.app
export const POSTR_CONFIG = {
  pdsHost: 'https://postrsocial.app',
  defaultDomain: 'postrsocial.app',
};
export const POSTR_PDS_ENDPOINT = POSTR_CONFIG.pdsHost;
export const BSKY_FALLBACK_PDS = 'https://bsky.social';
const SESSION_KEY = 'postr_social_session_v1';

// Global Application State
const state = {
  agent: null,
  session: null,
  pdsEndpoint: POSTR_CONFIG.pdsHost,
  profile: null,
  feed: [],
  activeTab: 'timeline', // 'timeline' | 'myposts'
  isResolvingPds: false,
  isSubmittingAuth: false,
  isPublishingPost: false,
  isRefreshingFeed: false,
  isOnline: navigator.onLine,
  deferredInstallPrompt: null,
};

// ==========================================
// Dynamic PDS Resolution & Endpoint Discovery
// ==========================================

/**
 * Resolves the user's home PDS endpoint.
 * Defaults directly to https://postrsocial.app.
 * If the user enters a specific external handle (e.g., .bsky.social or custom domain),
 * it dynamically discovers their home PDS or falls back safely to https://postrsocial.app.
 */
export async function resolveUserPds(identifier, manualOverride = '') {
  const trimmed = (identifier || '').trim().toLowerCase();
  const override = (manualOverride || '').trim();

  // 1. Manual user override if explicitly provided
  if (override) {
    let cleanUrl = override;
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    return cleanUrl.replace(/\/+$/, '');
  }

  // 2. Default standard: postrsocial.app
  if (!trimmed || trimmed.endsWith('.postrsocial.app') || trimmed === 'postrsocial.app' || trimmed.endsWith('@postrsocial.app')) {
    return POSTR_CONFIG.pdsHost;
  }

  // 3. Known Bluesky network handle
  if (trimmed.endsWith('.bsky.social')) {
    return BSKY_FALLBACK_PDS;
  }

  // 4. Custom domain handle resolution (e.g., user.domain.com)
  const handle = trimmed.replace(/^@/, '');
  if (!trimmed.includes('@') && handle.includes('.')) {
    try {
      let did = null;

      // Check standard HTTPS .well-known/atproto-did
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'text/plain' },
        });
        clearTimeout(timeout);
        if (res.ok) {
          const txt = (await res.text()).trim();
          if (txt.startsWith('did:plc:') || txt.startsWith('did:web:')) {
            did = txt;
          }
        }
      } catch {
        // Fall through to resolveHandle
      }

      // Check ATProto resolveHandle endpoint
      if (!did) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2500);
          const resolveRes = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, {
            method: 'GET',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });
          clearTimeout(timeout);
          if (resolveRes.ok) {
            const data = await resolveRes.json();
            if (data?.did) did = data.did;
          }
        } catch {
          // Fall through
        }
      }

      // If DID was resolved, find the PDS serviceEndpoint
      if (did && did.startsWith('did:plc:')) {
        const plcRes = await fetch(`https://plc.directory/${did}`, {
          headers: { Accept: 'application/json' },
        });
        if (plcRes.ok) {
          const doc = await plcRes.json();
          const services = doc.services || doc.service || [];
          const list = Array.isArray(services) ? services : Object.values(services);
          const pds = list.find((s) => s.type === 'AtprotoPersonalDataServer' || s.id === '#atproto_pds');
          if (pds && (pds.serviceEndpoint || pds.endpoint)) {
            return (pds.serviceEndpoint || pds.endpoint).replace(/\/+$/, '');
          }
        }
      }
    } catch (e) {
      console.warn('Postr Social: Dynamic resolution fallback engaged:', e.message);
    }
  }

  // Default hardcoded PDS target
  return POSTR_CONFIG.pdsHost;
}

// ==========================================
// Authentication Engine
// ==========================================

/**
 * Direct Password Login Flow targeting https://postrsocial.app
 */
export async function loginUser(identifier, password, manualPds = '') {
  setAuthLoading(true, 'Connecting to postrsocial.app...');
  try {
    const pdsUrl = await resolveUserPds(identifier, manualPds);
    setAuthLoading(true, `Authenticating with ${new URL(pdsUrl).hostname}...`);

    const agent = new BskyAgent({ service: pdsUrl });
    const response = await agent.login({
      identifier: identifier.trim(),
      password: password,
    });

    if (!response.success) {
      throw new Error('Authentication was rejected by the server.');
    }

    state.agent = agent;
    state.session = agent.session;
    state.pdsEndpoint = pdsUrl;

    saveSession(agent.session, pdsUrl);
    await onAuthSuccess();
  } catch (error) {
    console.error('Postr login error:', error);
    showAuthError(formatErrorMessage(error));
  } finally {
    setAuthLoading(false);
  }
}

/**
 * Signup Form Flow targeting https://postrsocial.app (invite codes disabled)
 */
export async function signupUser({ email, handle, password }) {
  setAuthLoading(true, 'Connecting to postrsocial.app registration...');
  try {
    const pdsUrl = POSTR_CONFIG.pdsHost;
    setAuthLoading(true, `Creating account on postrsocial.app...`);

    const agent = new BskyAgent({ service: pdsUrl });

    let finalHandle = handle.trim();
    if (!finalHandle.includes('.')) {
      finalHandle = `${finalHandle}.postrsocial.app`;
    }

    const createPayload = {
      email: email.trim(),
      handle: finalHandle,
      password: password,
    };

    // Call com.atproto.server.createAccount directly (invite codes disabled)
    const response = await agent.createAccount(createPayload);

    if (!response.success) {
      throw new Error('Could not create account on postrsocial.app.');
    }

    state.agent = agent;
    state.session = agent.session;
    state.pdsEndpoint = pdsUrl;

    saveSession(agent.session, pdsUrl);
    await onAuthSuccess();
  } catch (error) {
    console.error('Postr signup error:', error);
    showAuthError(formatErrorMessage(error));
  } finally {
    setAuthLoading(false);
  }
}

export function logoutUser() {
  localStorage.removeItem(SESSION_KEY);
  state.agent = null;
  state.session = null;
  state.profile = null;
  state.feed = [];

  renderLoggedOutView();
  showToast('Signed out of Postr Social', 'info');
}

export async function resumeExistingSession() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (!stored) return false;

  try {
    const { session, pdsEndpoint } = JSON.parse(stored);
    if (!session || !session.accessJwt) return false;

    showSplashMessage('Resuming Postr session...');
    const agent = new BskyAgent({ service: pdsEndpoint || POSTR_CONFIG.pdsHost });
    await agent.resumeSession(session);

    state.agent = agent;
    state.session = agent.session;
    state.pdsEndpoint = pdsEndpoint || POSTR_CONFIG.pdsHost;

    await onAuthSuccess();
    return true;
  } catch (err) {
    console.warn('Postr: Stored session invalid or expired:', err.message);
    localStorage.removeItem(SESSION_KEY);
    return false;
  } finally {
    hideSplashMessage();
  }
}

function saveSession(session, pdsEndpoint) {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        session,
        pdsEndpoint,
        savedAt: Date.now(),
      })
    );
  } catch (e) {
    console.warn('Could not save session to localStorage', e);
  }
}

async function onAuthSuccess() {
  hideAuthModal();
  clearAuthError();
  renderLoggedInView();
  await loadUserProfile();
  await loadTimelineFeed();
  showToast(`Welcome to Postr, @${state.session.handle}!`, 'success');
}

// ==========================================
// Feed & Post Creation Logic
// ==========================================

export async function loadUserProfile() {
  if (!state.agent || !state.session?.did) return;
  try {
    const res = await state.agent.getProfile({ actor: state.session.did });
    if (res.data) {
      state.profile = res.data;
      updateUserProfileUI(res.data);
    }
  } catch (err) {
    console.warn('Could not load profile:', err.message);
    updateUserProfileUI({
      handle: state.session.handle,
      displayName: state.session.handle,
      avatar: null,
    });
  }
}

export async function loadTimelineFeed() {
  if (!state.agent) return;
  state.isRefreshingFeed = true;
  updateFeedLoadingState(true);

  try {
    let feedItems = [];
    if (state.activeTab === 'timeline') {
      const res = await state.agent.getTimeline({ limit: 40 });
      feedItems = res.data?.feed || [];
    } else if (state.activeTab === 'myposts') {
      const res = await state.agent.getAuthorFeed({
        actor: state.session.did,
        limit: 40,
      });
      feedItems = res.data?.feed || [];
    }

    state.feed = feedItems;
    renderFeedList(feedItems);
  } catch (err) {
    console.error('Error fetching feed:', err);
    renderFeedError(formatErrorMessage(err));
  } finally {
    state.isRefreshingFeed = false;
    updateFeedLoadingState(false);
  }
}

export async function publishPost(text) {
  if (!state.agent) {
    showToast('You must be signed in to post.', 'error');
    return false;
  }
  const cleanText = text.trim();
  if (!cleanText) {
    showToast('Post content cannot be empty.', 'warning');
    return false;
  }
  if (cleanText.length > 300) {
    showToast('Post exceeds the 300 character AT Protocol limit.', 'warning');
    return false;
  }

  setPublishLoading(true);
  try {
    const record = {
      text: cleanText,
      createdAt: new Date().toISOString(),
    };

    await state.agent.post(record);
    showToast('Posted successfully to Postr Social!', 'success');

    const textarea = document.getElementById('composer-textarea');
    if (textarea) {
      textarea.value = '';
      updateCharCounter(0, 'composer-char-count');
    }
    closeComposerModal();

    await loadTimelineFeed();
    return true;
  } catch (err) {
    console.error('Post creation error:', err);
    showToast('Failed to post: ' + formatErrorMessage(err), 'error');
    return false;
  } finally {
    setPublishLoading(false);
  }
}

export async function toggleLikePost(postUri, postCid, currentLikeUri, btnElement) {
  if (!state.agent) return;

  try {
    btnElement.disabled = true;
    if (currentLikeUri) {
      await state.agent.deleteLike(currentLikeUri);
      btnElement.dataset.likeUri = '';
      btnElement.classList.remove('text-green-500');
      btnElement.classList.add('text-neutral-400');
      const countEl = btnElement.querySelector('.like-count');
      if (countEl) {
        countEl.textContent = Math.max(0, parseInt(countEl.textContent || '1', 10) - 1);
      }
      const icon = btnElement.querySelector('svg');
      if (icon) icon.setAttribute('fill', 'none');
    } else {
      const res = await state.agent.like(postUri, postCid);
      btnElement.dataset.likeUri = res.uri;
      btnElement.classList.add('text-green-500');
      btnElement.classList.remove('text-neutral-400');
      const countEl = btnElement.querySelector('.like-count');
      if (countEl) {
        countEl.textContent = parseInt(countEl.textContent || '0', 10) + 1;
      }
      const icon = btnElement.querySelector('svg');
      if (icon) icon.setAttribute('fill', 'currentColor');
    }
  } catch (err) {
    console.error('Like toggle error:', err);
    showToast('Could not update like: ' + formatErrorMessage(err), 'error');
  } finally {
    btnElement.disabled = false;
  }
}

export async function toggleRepost(postUri, postCid, currentRepostUri, btnElement) {
  if (!state.agent) return;

  try {
    btnElement.disabled = true;
    if (currentRepostUri) {
      await state.agent.deleteRepost(currentRepostUri);
      btnElement.dataset.repostUri = '';
      btnElement.classList.remove('text-green-500');
      btnElement.classList.add('text-neutral-400');
      const countEl = btnElement.querySelector('.repost-count');
      if (countEl) {
        countEl.textContent = Math.max(0, parseInt(countEl.textContent || '1', 10) - 1);
      }
    } else {
      const res = await state.agent.repost(postUri, postCid);
      btnElement.dataset.repostUri = res.uri;
      btnElement.classList.add('text-green-500');
      btnElement.classList.remove('text-neutral-400');
      const countEl = btnElement.querySelector('.repost-count');
      if (countEl) {
        countEl.textContent = parseInt(countEl.textContent || '0', 10) + 1;
      }
    }
  } catch (err) {
    console.error('Repost toggle error:', err);
    showToast('Could not repost: ' + formatErrorMessage(err), 'error');
  } finally {
    btnElement.disabled = false;
  }
}

// ==========================================
// UI Rendering & Template Functions
// ==========================================

function renderLoggedOutView() {
  const authContainer = document.getElementById('auth-view');
  const dashboardContainer = document.getElementById('dashboard-view');
  const mobileNav = document.getElementById('mobile-bottom-nav');

  if (authContainer) authContainer.classList.remove('hidden');
  if (dashboardContainer) dashboardContainer.classList.add('hidden');
  if (mobileNav) mobileNav.classList.add('hidden');
}

function renderLoggedInView() {
  const authContainer = document.getElementById('auth-view');
  const dashboardContainer = document.getElementById('dashboard-view');
  const mobileNav = document.getElementById('mobile-bottom-nav');

  if (authContainer) authContainer.classList.add('hidden');
  if (dashboardContainer) dashboardContainer.classList.remove('hidden');
  if (mobileNav) mobileNav.classList.remove('hidden');

  const pdsBadge = document.getElementById('active-pds-badge');
  if (pdsBadge && state.pdsEndpoint) {
    try {
      const hostname = new URL(state.pdsEndpoint).hostname;
      pdsBadge.textContent = hostname;
      pdsBadge.title = `PDS: ${state.pdsEndpoint}`;
    } catch {
      pdsBadge.textContent = state.pdsEndpoint;
    }
  }
}

function updateUserProfileUI(profile) {
  const avatarElements = document.querySelectorAll('.user-avatar-target');
  const handleElements = document.querySelectorAll('.user-handle-target');
  const nameElements = document.querySelectorAll('.user-name-target');
  const didElements = document.querySelectorAll('.user-did-target');
  const postsCountEl = document.getElementById('user-posts-count');
  const followersCountEl = document.getElementById('user-followers-count');
  const followsCountEl = document.getElementById('user-follows-count');

  const avatarUrl = profile.avatar || createAvatarPlaceholder(profile.handle || 'User');
  avatarElements.forEach((el) => {
    if (el.tagName === 'IMG') {
      el.src = avatarUrl;
      el.onerror = () => {
        el.src = createAvatarPlaceholder(profile.handle || 'User');
      };
    }
  });

  const displayHandle = profile.handle ? `@${profile.handle}` : '@anonymous';
  handleElements.forEach((el) => {
    el.textContent = displayHandle;
  });

  const displayName = profile.displayName || profile.handle || 'Postr User';
  nameElements.forEach((el) => {
    el.textContent = displayName;
  });

  if (didElements && state.session?.did) {
    didElements.forEach((el) => {
      const shortDid = state.session.did.slice(0, 14) + '...' + state.session.did.slice(-4);
      el.textContent = shortDid;
      el.title = state.session.did;
    });
  }

  if (postsCountEl && typeof profile.postsCount === 'number') {
    postsCountEl.textContent = formatNumber(profile.postsCount);
  }
  if (followersCountEl && typeof profile.followersCount === 'number') {
    followersCountEl.textContent = formatNumber(profile.followersCount);
  }
  if (followsCountEl && typeof profile.followsCount === 'number') {
    followsCountEl.textContent = formatNumber(profile.followsCount);
  }
}

function renderFeedList(items) {
  const container = document.getElementById('feed-container');
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="py-16 text-center text-neutral-400">
        <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 mb-4">
          <svg class="w-7 h-7 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"/>
          </svg>
        </div>
        <p class="text-base font-semibold text-white mb-1">Your Postr feed is empty</p>
        <p class="text-xs text-neutral-400 max-w-xs mx-auto">Be the first to share an update on postrsocial.app!</p>
        <button id="btn-feed-create-first" class="mt-4 px-4 py-2 rounded-xl bg-green-500 hover:bg-green-400 text-black text-xs font-bold transition shadow-lg shadow-green-950/40">
          Create First Post
        </button>
      </div>
    `;

    const createBtn = document.getElementById('btn-feed-create-first');
    if (createBtn) {
      createBtn.addEventListener('click', openComposerModal);
    }
    return;
  }

  const html = items
    .map((item) => {
      const post = item.post;
      if (!post) return '';

      const author = post.author || {};
      const record = post.record || {};
      const createdAt = record.createdAt || post.indexedAt;
      const timeAgo = formatTimeAgo(createdAt);
      const isLiked = !!post.viewer?.like;
      const isReposted = !!post.viewer?.repost;
      const likeUri = post.viewer?.like || '';
      const repostUri = post.viewer?.repost || '';
      const text = escapeHtml(record.text || '');
      const formattedText = linkify(text);

      const avatarSrc = author.avatar || createAvatarPlaceholder(author.handle || author.displayName || 'P');

      // Embedded Images (if any)
      let embedHtml = '';
      if (post.embed) {
        if (post.embed.$type === 'app.bsky.embed.images#view' && Array.isArray(post.embed.images)) {
          embedHtml = `
            <div class="mt-3 grid gap-2 ${post.embed.images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} rounded-2xl overflow-hidden border border-neutral-800">
              ${post.embed.images
                .map(
                  (img) => `
                <a href="${escapeHtml(img.fullsize)}" target="_blank" rel="noopener noreferrer" class="block bg-neutral-900 group">
                  <img src="${escapeHtml(img.thumb)}" alt="${escapeHtml(img.alt || 'Post attachment')}" class="w-full h-48 md:h-64 object-cover group-hover:scale-[1.01] transition duration-200" loading="lazy" />
                </a>
              `
                )
                .join('')}
            </div>
          `;
        } else if (post.embed.$type === 'app.bsky.embed.external#view' && post.embed.external) {
          const ext = post.embed.external;
          embedHtml = `
            <a href="${escapeHtml(ext.uri)}" target="_blank" rel="noopener noreferrer" class="mt-3 block p-3 rounded-2xl bg-neutral-900/80 border border-neutral-800 hover:border-green-500/50 transition">
              ${ext.thumb ? `<img src="${escapeHtml(ext.thumb)}" alt="" class="w-full h-36 object-cover rounded-xl mb-2" />` : ''}
              <div class="text-sm font-semibold text-white truncate">${escapeHtml(ext.title || ext.uri)}</div>
              ${ext.description ? `<p class="text-xs text-neutral-400 line-clamp-2 mt-1">${escapeHtml(ext.description)}</p>` : ''}
              <span class="text-[11px] text-green-400 mt-1 block truncate">${escapeHtml(new URL(ext.uri).hostname)}</span>
            </a>
          `;
        }
      }

      // Repost Indicator banner
      let repostHeader = '';
      if (item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
        const reposter = item.reason.by;
        repostHeader = `
          <div class="flex items-center gap-2 text-xs font-medium text-green-400/90 mb-2 pl-12">
            <svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            <span>Reposted by ${escapeHtml(reposter.displayName || reposter.handle)}</span>
          </div>
        `;
      }

      return `
        <article class="p-4 md:p-5 border-b border-neutral-900 hover:bg-neutral-950/40 transition duration-150">
          ${repostHeader}
          <div class="flex items-start gap-3">
            <!-- Author Avatar -->
            <a href="https://bsky.app/profile/${escapeHtml(author.handle)}" target="_blank" rel="noopener noreferrer" class="shrink-0 group">
              <img src="${avatarSrc}" alt="${escapeHtml(author.displayName || author.handle)}" class="w-10 h-10 rounded-full object-cover border border-neutral-800 group-hover:ring-2 group-hover:ring-green-500/60 transition" />
            </a>

            <!-- Content Column -->
            <div class="flex-1 min-w-0">
              <!-- Author metadata line -->
              <div class="flex items-baseline justify-between gap-2">
                <div class="flex items-baseline gap-1.5 truncate">
                  <span class="font-bold text-sm text-white truncate">${escapeHtml(author.displayName || author.handle)}</span>
                  <span class="text-xs text-neutral-400 truncate">@${escapeHtml(author.handle)}</span>
                </div>
                <time datetime="${createdAt}" class="text-[11px] text-neutral-500 shrink-0 font-mono">${timeAgo}</time>
              </div>

              <!-- Post Text -->
              <div class="mt-1 text-sm text-neutral-100 leading-relaxed break-words whitespace-pre-wrap selection:bg-green-500/30 selection:text-white">
                ${formattedText}
              </div>

              <!-- Media Embed -->
              ${embedHtml}

              <!-- Interactive Actions Bar -->
              <div class="mt-3 flex items-center justify-between text-xs text-neutral-400 max-w-sm pt-1">
                <!-- Reply -->
                <button class="flex items-center gap-1.5 hover:text-green-400 transition group p-1 -ml-1" title="Reply">
                  <svg class="w-4 h-4 group-hover:scale-110 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                  </svg>
                  <span>${post.replyCount || 0}</span>
                </button>

                <!-- Repost -->
                <button 
                  class="btn-repost flex items-center gap-1.5 ${isReposted ? 'text-green-500' : 'hover:text-green-400'} transition group p-1"
                  data-uri="${escapeHtml(post.uri)}"
                  data-cid="${escapeHtml(post.cid)}"
                  data-repost-uri="${escapeHtml(repostUri)}"
                  title="Repost"
                >
                  <svg class="w-4 h-4 group-hover:scale-110 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                  <span class="repost-count">${post.repostCount || 0}</span>
                </button>

                <!-- Like -->
                <button 
                  class="btn-like flex items-center gap-1.5 ${isLiked ? 'text-green-500' : 'hover:text-green-400'} transition group p-1"
                  data-uri="${escapeHtml(post.uri)}"
                  data-cid="${escapeHtml(post.cid)}"
                  data-like-uri="${escapeHtml(likeUri)}"
                  title="Like"
                >
                  <svg class="w-4 h-4 group-hover:scale-110 transition" fill="${isLiked ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                  </svg>
                  <span class="like-count">${post.likeCount || 0}</span>
                </button>

                <!-- Share -->
                <button 
                  class="btn-share flex items-center gap-1.5 hover:text-green-400 transition group p-1"
                  data-author="${escapeHtml(author.handle)}"
                  data-rkey="${post.uri.split('/').pop()}"
                  title="Share post"
                >
                  <svg class="w-4 h-4 group-hover:scale-110 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  container.innerHTML = html;

  container.querySelectorAll('.btn-like').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const uri = btn.dataset.uri;
      const cid = btn.dataset.cid;
      const likeUri = btn.dataset.likeUri;
      toggleLikePost(uri, cid, likeUri, btn);
    });
  });

  container.querySelectorAll('.btn-repost').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const uri = btn.dataset.uri;
      const cid = btn.dataset.cid;
      const repostUri = btn.dataset.repostUri;
      toggleRepost(uri, cid, repostUri, btn);
    });
  });

  container.querySelectorAll('.btn-share').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const author = btn.dataset.author;
      const rkey = btn.dataset.rkey;
      const postUrl = `https://postrsocial.app/profile/${author}/post/${rkey}`;

      if (navigator.share) {
        try {
          await navigator.share({
            title: `Post by @${author} on Postr Social`,
            url: postUrl,
          });
        } catch {
          // ignore share cancel
        }
      } else {
        await navigator.clipboard.writeText(postUrl);
        showToast('Post link copied to clipboard!', 'info');
      }
    });
  });
}

function renderFeedError(errorMsg) {
  const container = document.getElementById('feed-container');
  if (!container) return;

  container.innerHTML = `
    <div class="p-8 text-center text-neutral-400">
      <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-500/10 text-rose-400 mb-3">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
      </div>
      <p class="text-sm font-semibold text-rose-300">Feed temporarily unavailable</p>
      <p class="text-xs text-neutral-400 mt-1 max-w-sm mx-auto">${escapeHtml(errorMsg)}</p>
      <button id="btn-retry-feed" class="mt-4 px-4 py-1.5 rounded-lg bg-neutral-900 border border-neutral-800 hover:border-green-500 text-xs font-medium text-white transition">
        Retry Loading
      </button>
    </div>
  `;

  const retryBtn = document.getElementById('btn-retry-feed');
  if (retryBtn) {
    retryBtn.addEventListener('click', loadTimelineFeed);
  }
}

function updateFeedLoadingState(isLoading) {
  const spinner = document.getElementById('feed-refresh-spinner');
  const btnRefresh = document.getElementById('btn-refresh-feed');
  if (spinner) {
    if (isLoading) spinner.classList.remove('hidden');
    else spinner.classList.add('hidden');
  }
  if (btnRefresh) {
    btnRefresh.disabled = isLoading;
  }
}

// ==========================================
// In-App PWA Installation Engine
// ==========================================

function initPWAInstallation() {
  const installButtons = document.querySelectorAll('.pwa-install-trigger');
  const iosGuideModal = document.getElementById('pwa-ios-modal');
  const isIOS = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    installButtons.forEach((btn) => btn.classList.add('hidden'));
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    installButtons.forEach((btn) => btn.classList.remove('hidden'));
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    installButtons.forEach((btn) => btn.classList.add('hidden'));
    showToast('Postr Social installed successfully!', 'success');
  });

  installButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (state.deferredInstallPrompt) {
        state.deferredInstallPrompt.prompt();
        const choice = await state.deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          installButtons.forEach((b) => b.classList.add('hidden'));
        }
        state.deferredInstallPrompt = null;
      } else if (isIOS) {
        if (iosGuideModal) iosGuideModal.classList.remove('hidden');
      } else {
        showToast('Use browser menu [Add to Home screen] to install Postr Social.', 'info');
      }
    });
  });

  const iosCloseBtn = document.getElementById('pwa-ios-close');
  if (iosCloseBtn && iosGuideModal) {
    iosCloseBtn.addEventListener('click', () => {
      iosGuideModal.classList.add('hidden');
    });
  }
}

// ==========================================
// Network Connectivity Monitoring
// ==========================================

function initNetworkMonitor() {
  const offlineBanner = document.getElementById('offline-indicator');

  const updateNetworkStatus = () => {
    state.isOnline = navigator.onLine;
    if (offlineBanner) {
      if (state.isOnline) {
        offlineBanner.classList.add('hidden');
      } else {
        offlineBanner.classList.remove('hidden');
      }
    }
  };

  window.addEventListener('online', () => {
    updateNetworkStatus();
    showToast('Back online — sync restored', 'success');
    if (state.agent) loadTimelineFeed();
  });

  window.addEventListener('offline', () => {
    updateNetworkStatus();
    showToast('Offline Mode: updates paused', 'warning');
  });

  updateNetworkStatus();
}

// ==========================================
// Helper Utilities & Modal Controls
// ==========================================

function openComposerModal() {
  const modal = document.getElementById('composer-modal');
  if (modal) {
    modal.classList.remove('hidden');
    const textarea = document.getElementById('modal-composer-textarea');
    if (textarea) {
      textarea.focus();
    }
  }
}

function closeComposerModal() {
  const modal = document.getElementById('composer-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function setAuthLoading(isLoading, message = '') {
  state.isSubmittingAuth = isLoading;
  const loginSubmitBtn = document.getElementById('btn-login-submit');
  const signupSubmitBtn = document.getElementById('btn-signup-submit');
  const loadingStatusText = document.getElementById('auth-status-text');

  [loginSubmitBtn, signupSubmitBtn].forEach((btn) => {
    if (btn) {
      btn.disabled = isLoading;
      const spinner = btn.querySelector('.btn-spinner');
      if (spinner) {
        if (isLoading) spinner.classList.remove('hidden');
        else spinner.classList.add('hidden');
      }
    }
  });

  if (loadingStatusText) {
    if (isLoading && message) {
      loadingStatusText.textContent = message;
      loadingStatusText.classList.remove('hidden');
    } else {
      loadingStatusText.classList.add('hidden');
    }
  }
}

function setPublishLoading(isLoading) {
  state.isPublishingPost = isLoading;
  const publishButtons = document.querySelectorAll('.btn-publish-trigger');
  publishButtons.forEach((btn) => {
    btn.disabled = isLoading;
    const spinner = btn.querySelector('.btn-spinner');
    if (spinner) {
      if (isLoading) spinner.classList.remove('hidden');
      else spinner.classList.add('hidden');
    }
  });
}

function showAuthError(msg) {
  const errorBox = document.getElementById('auth-error-box');
  const errorText = document.getElementById('auth-error-text');
  if (errorBox && errorText) {
    errorText.textContent = msg;
    errorBox.classList.remove('hidden');
  }
}

function clearAuthError() {
  const errorBox = document.getElementById('auth-error-box');
  if (errorBox) errorBox.classList.add('hidden');
}

function hideAuthModal() {
  const authContainer = document.getElementById('auth-view');
  if (authContainer) authContainer.classList.add('hidden');
}

function showSplashMessage(msg) {
  const splash = document.getElementById('splash-screen');
  const text = document.getElementById('splash-text');
  if (splash) {
    splash.classList.remove('hidden');
    if (text) text.textContent = msg;
  }
}

function hideSplashMessage() {
  const splash = document.getElementById('splash-screen');
  if (splash) splash.classList.add('hidden');
}

export function showToast(message, type = 'info') {
  const toastContainer = document.getElementById('toast-container');
  if (!toastContainer) return;

  const toast = document.createElement('div');
  const bgColors = {
    info: 'bg-neutral-900 border-neutral-700 text-neutral-100',
    success: 'bg-neutral-950 border-green-500/80 text-green-300 shadow-green-950/40',
    warning: 'bg-neutral-950 border-amber-600/80 text-amber-300',
    error: 'bg-neutral-950 border-rose-600/80 text-rose-300',
  };

  toast.className = `flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-semibold shadow-2xl transition-all duration-300 transform translate-y-2 opacity-0 ${
    bgColors[type] || bgColors.info
  }`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

  toastContainer.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function updateCharCounter(length, counterElId = 'composer-char-count') {
  const countEl = document.getElementById(counterElId);
  if (!countEl) return;
  const remaining = 300 - length;
  countEl.textContent = `${remaining}`;

  if (remaining < 0) {
    countEl.className = 'text-xs font-mono font-bold text-rose-500';
  } else if (remaining < 20) {
    countEl.className = 'text-xs font-mono font-bold text-amber-400';
  } else {
    countEl.className = 'text-xs font-mono text-green-400/80';
  }
}

function formatErrorMessage(error) {
  if (!error) return 'An unexpected network error occurred.';
  const msg = error.message || String(error);

  if (msg.includes('Invalid identifier or password')) {
    return 'Invalid handle/email or password. Please verify your credentials.';
  }
  if (msg.includes('Handle not found') || msg.includes('Unable to resolve handle')) {
    return 'Could not locate that handle on postrsocial.app or the AT Protocol network.';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return 'Network connection issue or PDS is unreachable. Verify your connection to postrsocial.app.';
  }
  if (msg.includes('Token has expired') || msg.includes('ExpiredToken')) {
    return 'Session expired. Please sign in again.';
  }
  return msg;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function linkify(text) {
  if (!text) return '';
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let res = text.replace(
    urlRegex,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-green-400 hover:underline font-medium">$1</a>'
  );

  const mentionRegex = /(^|[\s])@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  res = res.replace(
    mentionRegex,
    '$1<a href="https://bsky.app/profile/$2" target="_blank" rel="noopener noreferrer" class="text-green-400 font-semibold hover:underline">@$2</a>'
  );

  return res;
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  try {
    const past = new Date(isoString).getTime();
    const diff = Math.floor((Date.now() - past) / 1000);

    if (diff < 60) return `${Math.max(1, diff)}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  } catch {
    return '';
  }
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function createAvatarPlaceholder(name) {
  const initial = (name.replace(/^@/, '')[0] || 'P').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
    <rect width="80" height="80" rx="40" fill="#000000" stroke="#22c55e" stroke-width="2"/>
    <text x="50%" y="54%" font-family="system-ui, -apple-system, sans-serif" font-size="34" font-weight="bold" fill="#22c55e" text-anchor="middle" dominant-baseline="middle">${initial}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ==========================================
// Event Listeners & Application Bootstrapping
// ==========================================

function setupEventListeners() {
  // 1. Auth Mode Switch (Log In vs Sign Up)
  const tabLogin = document.getElementById('tab-btn-login');
  const tabSignup = document.getElementById('tab-btn-signup');
  const formLogin = document.getElementById('form-login');
  const formSignup = document.getElementById('form-signup');

  if (tabLogin && tabSignup && formLogin && formSignup) {
    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('bg-neutral-900', 'text-white', 'shadow', 'border', 'border-neutral-800');
      tabLogin.classList.remove('text-neutral-400');
      tabSignup.classList.remove('bg-neutral-900', 'text-white', 'shadow', 'border', 'border-neutral-800');
      tabSignup.classList.add('text-neutral-400');
      formLogin.classList.remove('hidden');
      formSignup.classList.add('hidden');
      clearAuthError();
    });

    tabSignup.addEventListener('click', () => {
      tabSignup.classList.add('bg-neutral-900', 'text-white', 'shadow', 'border', 'border-neutral-800');
      tabSignup.classList.remove('text-neutral-400');
      tabLogin.classList.remove('bg-neutral-900', 'text-white', 'shadow', 'border', 'border-neutral-800');
      tabLogin.classList.add('text-neutral-400');
      formSignup.classList.remove('hidden');
      formLogin.classList.add('hidden');
      clearAuthError();
    });
  }

  // 2. Quick Suffix Helper Chips
  document.querySelectorAll('.btn-suffix-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const targetInput = document.getElementById(chip.dataset.targetInput);
      const suffix = chip.dataset.suffix;
      if (targetInput) {
        let val = targetInput.value.trim();
        val = val.replace(/\.(postrsocial\.app|bsky\.social)$/, '');
        targetInput.value = val ? `${val}${suffix}` : '';
        targetInput.focus();
      }
    });
  });

  // 3. Login Form Submission (hardcoded target: https://postrsocial.app)
  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const identifier = document.getElementById('login-identifier')?.value || '';
      const password = document.getElementById('login-password')?.value || '';

      if (!identifier.trim()) {
        showAuthError('Please enter your handle or email address.');
        return;
      }
      if (!password) {
        showAuthError('Please enter your account password.');
        return;
      }

      await loginUser(identifier, password);
    });
  }

  // 4. Signup Form Submission targeting https://postrsocial.app (invite code disabled)
  if (formSignup) {
    formSignup.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const email = document.getElementById('signup-email')?.value || '';
      let handle = document.getElementById('signup-handle')?.value || '';
      const password = document.getElementById('signup-password')?.value || '';

      if (!email.trim()) {
        showAuthError('Email address is required.');
        return;
      }
      if (!handle.trim()) {
        showAuthError('Desired handle is required.');
        return;
      }
      if (!password || password.length < 8) {
        showAuthError('Password must be at least 8 characters long.');
        return;
      }

      await signupUser({
        email,
        handle,
        password,
      });
    });
  }

  // 5. Logout Buttons
  document.querySelectorAll('.btn-logout-trigger').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (confirm('Sign out of Postr Social?')) {
        logoutUser();
      }
    });
  });

  // 6. Refresh Feed Button
  const btnRefreshFeed = document.getElementById('btn-refresh-feed');
  if (btnRefreshFeed) {
    btnRefreshFeed.addEventListener('click', loadTimelineFeed);
  }

  // 7. Feed Tab Switching (Timeline vs My Posts)
  const feedTabTimeline = document.getElementById('feed-tab-timeline');
  const feedTabMyPosts = document.getElementById('feed-tab-myposts');

  if (feedTabTimeline && feedTabMyPosts) {
    feedTabTimeline.addEventListener('click', () => {
      if (state.activeTab === 'timeline') return;
      state.activeTab = 'timeline';
      feedTabTimeline.classList.add('border-green-500', 'text-white');
      feedTabTimeline.classList.remove('border-transparent', 'text-neutral-400');
      feedTabMyPosts.classList.remove('border-green-500', 'text-white');
      feedTabMyPosts.classList.add('border-transparent', 'text-neutral-400');
      loadTimelineFeed();
    });

    feedTabMyPosts.addEventListener('click', () => {
      if (state.activeTab === 'myposts') return;
      state.activeTab = 'myposts';
      feedTabMyPosts.classList.add('border-green-500', 'text-white');
      feedTabMyPosts.classList.remove('border-transparent', 'text-neutral-400');
      feedTabTimeline.classList.remove('border-green-500', 'text-white');
      feedTabTimeline.classList.add('border-transparent', 'text-neutral-400');
      loadTimelineFeed();
    });
  }

  // 8. Inline Composer
  const composerTextarea = document.getElementById('composer-textarea');
  const btnInlinePublish = document.getElementById('btn-inline-publish');

  if (composerTextarea) {
    composerTextarea.addEventListener('input', () => {
      updateCharCounter(composerTextarea.value.length, 'composer-char-count');
    });
  }

  if (btnInlinePublish && composerTextarea) {
    btnInlinePublish.addEventListener('click', async () => {
      await publishPost(composerTextarea.value);
    });
  }

  // 9. Modal Composer
  const btnOpenComposer = document.querySelectorAll('.btn-open-composer');
  const btnCloseComposer = document.getElementById('btn-close-composer');
  const modalTextarea = document.getElementById('modal-composer-textarea');
  const btnModalPublish = document.getElementById('btn-modal-publish');

  btnOpenComposer.forEach((btn) => {
    btn.addEventListener('click', openComposerModal);
  });

  if (btnCloseComposer) {
    btnCloseComposer.addEventListener('click', closeComposerModal);
  }

  if (modalTextarea) {
    modalTextarea.addEventListener('input', () => {
      updateCharCounter(modalTextarea.value.length, 'modal-char-count');
    });
  }

  if (btnModalPublish && modalTextarea) {
    btnModalPublish.addEventListener('click', async () => {
      const ok = await publishPost(modalTextarea.value);
      if (ok) {
        modalTextarea.value = '';
        updateCharCounter(0, 'modal-char-count');
      }
    });
  }
}

// Bootstrap on DOM Ready
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  initPWAInstallation();
  initNetworkMonitor();

  const resumed = await resumeExistingSession();
  if (!resumed) {
    renderLoggedOutView();
  }
});
