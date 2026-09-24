/**
 * Postr Social (postersocial.app)
 * Modern, mobile-first Progressive Web App powered by AT Protocol (@atproto/api)
 * Standalone ESM implementation for direct browser & PWA execution.
 */

import { BskyAgent } from 'https://esm.sh/@atproto/api@0.14.8';

// ==========================================
// Configuration & Constants
// ==========================================
export const POSTR_CONFIG = {
  pdsHost: 'https://postersocial.app',
  defaultDomain: 'postersocial.app',
  bskyFallback: 'https://bsky.social',
  sessionKey: 'postr_social_session_v1',
};

export const POSTR_PDS_ENDPOINT = POSTR_CONFIG.pdsHost;
export const BSKY_FALLBACK_PDS = POSTR_CONFIG.bskyFallback;

// Global Application State
const state = {
  agent: null,
  session: null,
  pdsEndpoint: POSTR_CONFIG.pdsHost,
  profile: null,
  feed: [],
  activeView: 'feed', // 'feed' | 'search' | 'profile'
  activeFeedTab: 'timeline', // 'timeline' | 'myposts'
  isResolvingPds: false,
  isSubmittingAuth: false,
  isPublishingPost: false,
  isRefreshingFeed: false,
  isOnline: navigator.onLine,
  deferredInstallPrompt: null,

  // Composer attachments state
  inlineImages: [],
  inlineVideo: null,
  modalImages: [],
  modalVideo: null,

  // Profile edit pending avatar
  pendingAvatarFile: null,

  // Follow tracking cache (did -> followUri or boolean)
  followingMap: new Map(),
};

// ==========================================
// Dynamic PDS & Handle Resolution
// ==========================================
/**
 * Automatically discovers the user's home PDS endpoint.
 * Defaults directly to https://postersocial.app.
 */
export async function resolveUserPds(identifier) {
  const trimmed = identifier.trim().toLowerCase();

  // 1. If explicit postersocial.app domain
  if (!trimmed || trimmed.endsWith('.postersocial.app') || trimmed === 'postersocial.app' || trimmed.endsWith('@postersocial.app')) {
    return POSTR_CONFIG.pdsHost;
  }

  // 2. Explicit bsky.social fallback
  if (trimmed.endsWith('.bsky.social') || trimmed === 'bsky.social') {
    return POSTR_CONFIG.bskyFallback;
  }

  // 3. Attempt dynamic resolution for custom handles
  try {
    let domainToQuery = trimmed;
    if (domainToQuery.includes('@')) {
      domainToQuery = domainToQuery.split('@')[1];
    }

    if (domainToQuery.includes('.')) {
      const wellKnownUrl = `https://${domainToQuery}/.well-known/atproto-did`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      try {
        const res = await fetch(wellKnownUrl, {
          method: 'GET',
          mode: 'cors',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const did = (await res.text()).trim();
          if (did.startsWith('did:plc:')) {
            const plcRes = await fetch(`https://plc.directory/${did}`, { mode: 'cors' });
            if (plcRes.ok) {
              const plcDoc = await plcRes.json();
              const pdsService = plcDoc.service?.find((s) => s.type === 'AtprotoPersonalDataServer');
              if (pdsService && pdsService.serviceEndpoint) {
                return pdsService.serviceEndpoint;
              }
            }
          }
        }
      } catch {
        // Fall through safely to default
      }
    }
  } catch (err) {
    console.warn('Postr PDS discovery fallback triggered:', err);
  }

  return POSTR_CONFIG.pdsHost;
}

// ==========================================
// Authentication: Login, Signup, Resume, Logout
// ==========================================

export async function loginUser(identifier, password) {
  if (state.isSubmittingAuth) return;
  state.isSubmittingAuth = true;
  clearAuthError();
  setAuthLoading(true, 'Locating PDS endpoint for ' + identifier + '...');

  try {
    const pdsEndpoint = await resolveUserPds(identifier);
    state.pdsEndpoint = pdsEndpoint;
    setAuthLoading(true, `Authenticating with ${pdsEndpoint.replace('https://', '')}...`);

    const agent = new BskyAgent({ service: pdsEndpoint });
    await agent.login({ identifier: identifier.trim(), password });

    state.agent = agent;
    state.session = agent.session;

    saveSession(agent.session, pdsEndpoint);
    await onAuthSuccess();
  } catch (error) {
    console.error('Postr login error:', error);
    showAuthError(formatErrorMessage(error));
  } finally {
    state.isSubmittingAuth = false;
    setAuthLoading(false);
  }
}

export async function signupUser(email, handle, password) {
  if (state.isSubmittingAuth) return;
  state.isSubmittingAuth = true;
  clearAuthError();
  setAuthLoading(true, 'Connecting to postersocial.app registration...');

  try {
    const targetPds = POSTR_CONFIG.pdsHost;
    state.pdsEndpoint = targetPds;

    let finalHandle = handle.trim().toLowerCase();
    if (!finalHandle.includes('.')) {
      finalHandle = `${finalHandle}.${POSTR_CONFIG.defaultDomain}`;
    }

    setAuthLoading(true, `Creating account @${finalHandle}...`);
    const agent = new BskyAgent({ service: targetPds });

    await agent.createAccount({
      email: email.trim(),
      handle: finalHandle,
      password,
    });

    if (agent.session) {
      state.agent = agent;
      state.session = agent.session;
      saveSession(agent.session, targetPds);
      await onAuthSuccess();
    } else {
      showAuthSuccessNotice('Account created! Logging in...');
      await agent.login({ identifier: finalHandle, password });
      state.agent = agent;
      state.session = agent.session;
      saveSession(agent.session, targetPds);
      await onAuthSuccess();
    }
  } catch (error) {
    console.error('Postr account creation error:', error);
    showAuthError(formatErrorMessage(error));
  } finally {
    state.isSubmittingAuth = false;
    setAuthLoading(false);
  }
}

export async function resumeExistingSession() {
  const stored = localStorage.getItem(POSTR_CONFIG.sessionKey);
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
    console.warn('Session resume expired or invalid:', err);
    localStorage.removeItem(POSTR_CONFIG.sessionKey);
    return false;
  } finally {
    hideSplashScreen();
  }
}

export function logoutUser() {
  localStorage.removeItem(POSTR_CONFIG.sessionKey);
  state.agent = null;
  state.session = null;
  state.profile = null;
  state.feed = [];
  state.followingMap.clear();

  document.getElementById('auth-view')?.classList.remove('hidden');
  document.getElementById('dashboard-view')?.classList.add('hidden');
  document.getElementById('mobile-bottom-nav')?.classList.add('hidden');
  switchAppView('feed');
  showToast('Logged out of Postr Social', 'info');
}

function saveSession(session, pdsEndpoint) {
  try {
    localStorage.setItem(
      POSTR_CONFIG.sessionKey,
      JSON.stringify({ session, pdsEndpoint })
    );
  } catch (e) {
    console.error('Could not save session token to localStorage:', e);
  }
}

async function onAuthSuccess() {
  document.getElementById('auth-view')?.classList.add('hidden');
  document.getElementById('dashboard-view')?.classList.remove('hidden');
  document.getElementById('mobile-bottom-nav')?.classList.remove('hidden');

  updatePdsBadgeUI(state.pdsEndpoint);
  switchAppView('feed');

  // Load user profile & timeline
  await loadUserProfile();
  await loadFeed('timeline');
}

// ==========================================
// User Profile & Profile Editing
// ==========================================

export async function loadUserProfile() {
  if (!state.agent || !state.session?.did) return;

  try {
    const response = await state.agent.getProfile({ actor: state.session.did });
    const profile = response.data;
    state.profile = profile;
    renderUserProfileUI(profile);
  } catch (err) {
    console.error('Error fetching user profile:', err);
  }
}

function renderUserProfileUI(profile) {
  if (!profile) return;

  // Sync avatar everywhere
  const avatarElements = document.querySelectorAll('.user-avatar-target');
  avatarElements.forEach((el) => {
    if (profile.avatar) {
      el.src = profile.avatar;
    } else {
      el.src = '/icon.svg';
    }
  });

  // Sync display names
  const nameElements = document.querySelectorAll('.user-name-target');
  nameElements.forEach((el) => {
    el.textContent = profile.displayName || profile.handle || 'Postr User';
  });

  // Sync handles
  const handleElements = document.querySelectorAll('.user-handle-target');
  handleElements.forEach((el) => {
    el.textContent = `@${profile.handle}`;
  });

  // Sync DIDs
  const didElements = document.querySelectorAll('.user-did-target');
  didElements.forEach((el) => {
    el.textContent = profile.did || '';
    el.setAttribute('title', profile.did || '');
  });

  // Profile View Bio & Banner
  const bioEl = document.getElementById('profile-view-bio');
  if (bioEl) {
    bioEl.textContent = profile.description || 'No bio provided yet. Click Edit Profile to add one.';
  }

  const bannerEl = document.getElementById('profile-banner');
  if (bannerEl) {
    if (profile.banner) {
      bannerEl.style.backgroundImage = `url(${profile.banner})`;
      bannerEl.style.backgroundSize = 'cover';
      bannerEl.style.backgroundPosition = 'center';
    } else {
      bannerEl.style.backgroundImage = '';
    }
  }

  // Counts
  const postsCountEl = document.getElementById('user-posts-count');
  if (postsCountEl) postsCountEl.textContent = profile.postsCount ?? '0';

  const followersCountEl = document.getElementById('user-followers-count');
  if (followersCountEl) followersCountEl.textContent = profile.followersCount ?? '0';

  const followsCountEl = document.getElementById('user-follows-count');
  if (followsCountEl) followsCountEl.textContent = profile.followsCount ?? '0';

  // Seed edit profile modal fields
  const editName = document.getElementById('edit-display-name');
  if (editName) editName.value = profile.displayName || '';

  const editBio = document.getElementById('edit-bio');
  if (editBio) {
    editBio.value = profile.description || '';
    const bioCount = document.getElementById('edit-bio-char-count');
    if (bioCount) bioCount.textContent = 256 - (profile.description?.length || 0);
  }

  const editAvatarPreview = document.getElementById('edit-profile-avatar-preview');
  if (editAvatarPreview) {
    editAvatarPreview.src = profile.avatar || '/icon.svg';
  }
}

/**
 * Updates profile details and avatar on the AT Protocol PDS.
 */
export async function saveProfileChanges({ displayName, description, avatarFile }) {
  if (!state.agent) throw new Error('Agent not authenticated');

  const saveBtn = document.getElementById('btn-save-profile');
  const spinner = document.getElementById('save-profile-spinner');
  if (saveBtn) saveBtn.disabled = true;
  if (spinner) spinner.classList.remove('hidden');

  try {
    let avatarBlob = null;
    if (avatarFile) {
      // Upload blob
      const blobRes = await state.agent.uploadBlob(avatarFile, {
        encoding: avatarFile.type || 'image/jpeg',
      });
      avatarBlob = blobRes.data.blob;
    }

    // Call upsertProfile
    await state.agent.upsertProfile((existing) => {
      const updated = {
        ...existing,
        displayName: displayName.trim(),
        description: description.trim(),
      };
      if (avatarBlob) {
        updated.avatar = avatarBlob;
      }
      return updated;
    });

    state.pendingAvatarFile = null;
    closeModal('edit-profile-modal');
    showToast('Profile updated successfully!', 'success');

    // Reload profile
    await loadUserProfile();
  } catch (error) {
    console.error('Error saving profile changes:', error);
    showToast('Failed to update profile: ' + formatErrorMessage(error), 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (spinner) spinner.classList.add('hidden');
  }
}

// ==========================================
// Social Feed: Timeline, My Posts & Rendering
// ==========================================

export async function loadFeed(tab = 'timeline') {
  if (!state.agent) return;
  state.activeFeedTab = tab;
  state.isRefreshingFeed = true;

  const refreshSpinner = document.getElementById('feed-refresh-spinner');
  if (refreshSpinner) refreshSpinner.classList.remove('hidden');

  const feedContainer = document.getElementById('feed-container');
  const profilePostsContainer = document.getElementById('profile-posts-container');
  const targetContainer = state.activeView === 'profile' ? profilePostsContainer : feedContainer;

  if (targetContainer) {
    targetContainer.innerHTML = `
      <div class="p-8 text-center text-neutral-500 text-xs flex flex-col items-center justify-center gap-2">
        <svg class="w-6 h-6 animate-spin text-green-500" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span>Loading posts from ${state.pdsEndpoint.replace('https://', '')}...</span>
      </div>
    `;
  }

  try {
    let posts = [];
    if (tab === 'timeline') {
      const res = await state.agent.getTimeline({ limit: 35 });
      posts = res.data.feed || [];
    } else {
      const res = await state.agent.getAuthorFeed({
        actor: state.session.did,
        limit: 35,
      });
      posts = res.data.feed || [];
    }

    state.feed = posts;
    renderFeedList(posts, targetContainer);

    // Also sync profile posts if we are in profile view
    if (profilePostsContainer && targetContainer !== profilePostsContainer && tab === 'myposts') {
      renderFeedList(posts, profilePostsContainer);
    }
  } catch (error) {
    console.error('Error fetching feed:', error);
    if (targetContainer) {
      targetContainer.innerHTML = `
        <div class="p-8 text-center text-neutral-400 text-xs space-y-2">
          <p class="text-rose-400 font-semibold">Could not load posts</p>
          <p class="text-neutral-500 text-[11px]">${formatErrorMessage(error)}</p>
          <button id="btn-feed-retry" class="mt-3 px-3 py-1.5 rounded-lg bg-neutral-900 border border-neutral-800 text-white text-xs hover:border-green-500 transition">
            Try Again
          </button>
        </div>
      `;
      document.getElementById('btn-feed-retry')?.addEventListener('click', () => loadFeed(tab));
    }
  } finally {
    state.isRefreshingFeed = false;
    if (refreshSpinner) refreshSpinner.classList.add('hidden');
  }
}

function renderFeedList(posts, container) {
  if (!container) return;

  if (!posts || posts.length === 0) {
    container.innerHTML = `
      <div class="p-12 text-center text-neutral-500">
        <div class="w-12 h-12 rounded-2xl bg-neutral-900/80 border border-neutral-800 mx-auto flex items-center justify-center mb-3 text-neutral-600">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"/>
          </svg>
        </div>
        <p class="text-base font-semibold text-white mb-1">Your Postr feed is empty</p>
        <p class="text-xs text-neutral-400 max-w-xs mx-auto">Be the first to share an update on postersocial.app!</p>
        <button class="btn-open-composer mt-4 px-4 py-2 rounded-xl bg-green-500 hover:bg-green-400 text-black text-xs font-bold transition shadow-lg shadow-green-950/40">
          Create First Post
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  posts.forEach((item) => {
    const post = item.post;
    if (!post) return;
    const postCard = createPostCardElement(post, item.reason);
    container.appendChild(postCard);
  });
}

function createPostCardElement(post, reason) {
  const card = document.createElement('article');
  card.className = 'p-4 hover:bg-neutral-950/70 transition border-b border-neutral-900 flex gap-3 text-white';
  card.dataset.uri = post.uri;
  card.dataset.cid = post.cid;

  const author = post.author || {};
  const record = post.record || {};
  const textContent = record.text || '';
  const createdAt = record.createdAt ? formatTimeAgo(record.createdAt) : '';

  // Viewer interactions
  const isLiked = Boolean(post.viewer?.like);
  const likeUri = post.viewer?.like || '';
  const isReposted = Boolean(post.viewer?.repost);
  const repostUri = post.viewer?.repost || '';
  const likeCount = post.likeCount ?? 0;
  const repostCount = post.repostCount ?? 0;
  const replyCount = post.replyCount ?? 0;

  // Repost Header note
  let repostHeaderHtml = '';
  if (reason && reason.$type === 'app.bsky.feed.defs#reasonRepost') {
    const reposterName = reason.by?.displayName || reason.by?.handle || 'Someone';
    repostHeaderHtml = `
      <div class="flex items-center gap-1.5 text-[11px] text-neutral-500 mb-1.5 ml-12">
        <svg class="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        <span>Reposted by ${escapeHtml(reposterName)}</span>
      </div>
    `;
  }

  // Embed rendering (Images, Video, or External)
  const embedHtml = renderPostEmbed(post.embed);

  card.innerHTML = `
    <div class="flex-1 min-w-0">
      ${repostHeaderHtml}
      <div class="flex gap-3">
        <!-- Author Avatar -->
        <a href="#actor-${author.handle}" class="shrink-0" title="${author.handle}">
          <img
            src="${author.avatar || '/icon.svg'}"
            alt="${escapeHtml(author.displayName || author.handle || 'Avatar')}"
            class="w-10 h-10 rounded-full object-cover border border-neutral-800 hover:border-green-500/50 transition"
            loading="lazy"
          />
        </a>

        <div class="flex-1 min-w-0">
          <!-- Author Info Line -->
          <div class="flex items-baseline justify-between gap-2">
            <div class="flex items-center gap-1.5 truncate">
              <span class="font-bold text-sm text-white hover:text-green-400 transition cursor-pointer truncate">
                ${escapeHtml(author.displayName || author.handle || 'Postr User')}
              </span>
              <span class="text-xs text-neutral-400 font-mono truncate">
                @${escapeHtml(author.handle || '')}
              </span>
            </div>
            <time class="text-[11px] text-neutral-400 shrink-0 font-mono">${createdAt}</time>
          </div>

          <!-- Post Content Text -->
          <div class="mt-1.5 text-sm text-neutral-100 whitespace-pre-wrap break-words leading-relaxed">
            ${linkifyText(escapeHtml(textContent))}
          </div>

          <!-- Embed Preview -->
          ${embedHtml}

          <!-- Post Interaction Buttons (Reply, Repost, Like, Share) -->
          <div class="mt-3 pt-2 flex items-center justify-between text-neutral-400 text-xs max-w-md">
            <!-- Reply -->
            <button class="btn-post-reply flex items-center gap-1.5 hover:text-green-400 transition" title="Reply">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
              <span>${replyCount > 0 ? replyCount : ''}</span>
            </button>

            <!-- Repost -->
            <button
              class="btn-post-repost flex items-center gap-1.5 ${isReposted ? 'text-green-400' : 'hover:text-green-400'} transition"
              data-reposted="${isReposted}"
              data-repost-uri="${repostUri}"
              data-uri="${post.uri}"
              data-cid="${post.cid}"
              title="Repost"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              <span class="repost-counter">${repostCount > 0 ? repostCount : ''}</span>
            </button>

            <!-- Like -->
            <button
              class="btn-post-like flex items-center gap-1.5 ${isLiked ? 'text-green-400' : 'hover:text-green-400'} transition"
              data-liked="${isLiked}"
              data-like-uri="${likeUri}"
              data-uri="${post.uri}"
              data-cid="${post.cid}"
              title="Like"
            >
              <svg class="w-4 h-4 ${isLiked ? 'fill-current' : 'fill-none'}" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
              </svg>
              <span class="like-counter">${likeCount > 0 ? likeCount : ''}</span>
            </button>

            <!-- Share -->
            <button
              class="btn-post-share flex items-center gap-1.5 hover:text-green-400 transition"
              data-author="${author.handle}"
              data-rkey="${post.uri.split('/').pop()}"
              title="Share Link"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  return card;
}

function renderPostEmbed(embed) {
  if (!embed) return '';

  // 1. Images Embed (app.bsky.embed.images#view)
  if (embed.$type === 'app.bsky.embed.images#view' && Array.isArray(embed.images)) {
    const gridCols = embed.images.length === 1 ? 'grid-cols-1' : 'grid-cols-2';
    const imgsHtml = embed.images
      .map((img) => `
        <div class="relative overflow-hidden rounded-xl bg-neutral-900 border border-neutral-800">
          <img
            src="${img.thumb || img.fullsize}"
            alt="${escapeHtml(img.alt || 'Post image')}"
            class="w-full h-48 object-cover hover:scale-102 transition duration-200 cursor-pointer"
            loading="lazy"
            onclick="window.open('${img.fullsize || img.thumb}', '_blank')"
          />
        </div>
      `)
      .join('');

    return `<div class="mt-2.5 grid ${gridCols} gap-2 rounded-xl overflow-hidden">${imgsHtml}</div>`;
  }

  // 2. Video Embed (app.bsky.embed.video#view or external)
  if (embed.$type === 'app.bsky.embed.video#view') {
    const playlistUrl = embed.playlist || '';
    const thumbnail = embed.thumbnail || '';
    return `
      <div class="mt-2.5 rounded-xl overflow-hidden border border-neutral-800 bg-black">
        <video
          controls
          poster="${thumbnail}"
          class="w-full max-h-72 object-contain bg-black"
          preload="metadata"
        >
          <source src="${playlistUrl}" type="application/x-mpegURL">
          Your browser does not support video playback.
        </video>
      </div>
    `;
  }

  // 3. External link card (app.bsky.embed.external#view)
  if (embed.$type === 'app.bsky.embed.external#view' && embed.external) {
    const ext = embed.external;
    return `
      <a
        href="${ext.uri}"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-2.5 block rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900 hover:border-neutral-700 transition"
      >
        ${ext.thumb ? `<img src="${ext.thumb}" class="w-full h-36 object-cover" loading="lazy" />` : ''}
        <div class="p-3">
          <p class="text-xs font-bold text-white line-clamp-1">${escapeHtml(ext.title || '')}</p>
          <p class="text-[11px] text-neutral-400 line-clamp-2 mt-0.5">${escapeHtml(ext.description || '')}</p>
          <span class="text-[10px] font-mono text-green-400 mt-1 block truncate">${ext.uri}</span>
        </div>
      </a>
    `;
  }

  // 4. Record with media
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view' && embed.media) {
    return renderPostEmbed(embed.media);
  }

  return '';
}

// ==========================================
// Post Composer: Text, Photo & Video uploads
// ==========================================

export async function publishPost({ text, images = [], video = null }) {
  if (!state.agent) throw new Error('Not logged in');
  if (state.isPublishingPost) return;

  const trimmedText = text.trim();
  if (!trimmedText && images.length === 0 && !video) {
    throw new Error('Please enter some text or attach an image or video.');
  }

  state.isPublishingPost = true;
  setPublishButtonLoading(true);

  try {
    let embed = undefined;

    // 1. Upload photo attachments if any
    if (images && images.length > 0) {
      showToast(`Uploading ${images.length} photo(s)...`, 'info');
      const uploadedBlobs = [];
      for (const file of images) {
        const res = await state.agent.uploadBlob(file, {
          encoding: file.type || 'image/jpeg',
        });
        uploadedBlobs.push({
          image: res.data.blob,
          alt: 'Postr photo attachment',
        });
      }

      embed = {
        $type: 'app.bsky.embed.images',
        images: uploadedBlobs,
      };
    }

    // 2. Upload video if attached
    if (video) {
      showToast('Uploading video file...', 'info');
      const videoRes = await state.agent.uploadBlob(video, {
        encoding: video.type || 'video/mp4',
      });

      embed = {
        $type: 'app.bsky.embed.video',
        video: videoRes.data.blob,
      };
    }

    // 3. Post to timeline
    await state.agent.post({
      text: trimmedText,
      embed,
      createdAt: new Date().toISOString(),
    });

    // Reset fields
    clearComposerForms();
    closeModal('composer-modal');
    showToast('Post published successfully!', 'success');

    // Refresh feed
    await loadFeed('timeline');
  } catch (error) {
    console.error('Error publishing post:', error);
    showToast('Failed to post: ' + formatErrorMessage(error), 'error');
  } finally {
    state.isPublishingPost = false;
    setPublishButtonLoading(false);
  }
}

function clearComposerForms() {
  const inlineText = document.getElementById('composer-textarea');
  if (inlineText) inlineText.value = '';

  const modalText = document.getElementById('modal-composer-textarea');
  if (modalText) modalText.value = '';

  state.inlineImages = [];
  state.inlineVideo = null;
  state.modalImages = [];
  state.modalVideo = null;

  renderComposerAttachments('inline');
  renderComposerAttachments('modal');
  updateCharCounter();
}

function renderComposerAttachments(context = 'inline') {
  const isInline = context === 'inline';
  const previewBox = document.getElementById(isInline ? 'inline-attachments-preview' : 'modal-attachments-preview');
  const imagesGrid = document.getElementById(isInline ? 'inline-images-grid' : 'modal-images-grid');
  const videoBox = document.getElementById(isInline ? 'inline-video-preview-box' : 'modal-video-preview-box');
  const videoPlayer = document.getElementById(isInline ? 'inline-video-player' : 'modal-video-player');

  const images = isInline ? state.inlineImages : state.modalImages;
  const video = isInline ? state.inlineVideo : state.modalVideo;

  if (!previewBox) return;

  if (images.length === 0 && !video) {
    previewBox.classList.add('hidden');
    return;
  }

  previewBox.classList.remove('hidden');

  // Render images
  if (imagesGrid) {
    imagesGrid.innerHTML = '';
    images.forEach((file, index) => {
      const url = URL.createObjectURL(file);
      const thumb = document.createElement('div');
      thumb.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-neutral-700 bg-neutral-900 group';
      thumb.innerHTML = `
        <img src="${url}" class="w-full h-full object-cover" />
        <button type="button" class="btn-remove-img absolute top-1 right-1 w-5 h-5 rounded-full bg-black/80 text-white hover:bg-rose-600 flex items-center justify-center text-[10px] transition" data-context="${context}" data-index="${index}">
          ✕
        </button>
      `;
      imagesGrid.appendChild(thumb);
    });
  }

  // Render video
  if (videoBox && videoPlayer) {
    if (video) {
      videoBox.classList.remove('hidden');
      videoPlayer.src = URL.createObjectURL(video);
    } else {
      videoBox.classList.add('hidden');
      videoPlayer.src = '';
    }
  }
}

// ==========================================
// Account Discovery & Following (Search)
// ==========================================

export async function searchAccounts(query) {
  if (!state.agent) return;
  const container = document.getElementById('search-results-container');
  if (!container) return;

  const trimmed = query.trim();
  if (!trimmed) {
    container.innerHTML = `
      <div class="py-12 text-center text-neutral-500 text-xs">
        Type in the box above to find accounts on postersocial.app and the AT Protocol network.
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="p-8 text-center text-neutral-500 text-xs flex flex-col items-center justify-center gap-2">
      <svg class="w-5 h-5 animate-spin text-green-500" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>Searching accounts for "${escapeHtml(trimmed)}"...</span>
    </div>
  `;

  try {
    const res = await state.agent.searchActors({ term: trimmed, limit: 25 });
    const actors = res.data.actors || [];

    if (actors.length === 0) {
      container.innerHTML = `
        <div class="py-12 text-center text-neutral-400 text-xs">
          No accounts found matching "${escapeHtml(trimmed)}".
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    actors.forEach((actor) => {
      const card = createActorCardElement(actor);
      container.appendChild(card);
    });
  } catch (error) {
    console.error('Error searching actors:', error);
    container.innerHTML = `
      <div class="py-8 text-center text-rose-400 text-xs">
        Error searching accounts: ${formatErrorMessage(error)}
      </div>
    `;
  }
}

function createActorCardElement(actor) {
  const el = document.createElement('div');
  el.className = 'p-4 flex items-center justify-between gap-3 hover:bg-neutral-950/60 transition border-b border-neutral-900 text-white';

  const isFollowing = Boolean(actor.viewer?.following) || state.followingMap.get(actor.did);
  const followUri = actor.viewer?.following || state.followingMap.get(actor.did) || '';

  el.innerHTML = `
    <div class="flex items-center gap-3 min-w-0 flex-1">
      <img
        src="${actor.avatar || '/icon.svg'}"
        alt=""
        class="w-11 h-11 rounded-full object-cover border border-neutral-800 shrink-0"
        loading="lazy"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 truncate">
          <span class="font-bold text-sm text-white truncate">${escapeHtml(actor.displayName || actor.handle)}</span>
        </div>
        <p class="text-xs text-neutral-400 font-mono truncate">@${escapeHtml(actor.handle)}</p>
        ${actor.description ? `<p class="text-[11px] text-neutral-300 line-clamp-1 mt-0.5">${escapeHtml(actor.description)}</p>` : ''}
      </div>
    </div>

    <!-- Follow / Unfollow Button -->
    <button
      class="btn-follow-toggle px-3.5 py-1.5 rounded-xl text-xs font-bold transition shrink-0 ${
        isFollowing
          ? 'bg-neutral-900 hover:bg-neutral-800 text-white border border-neutral-700 hover:border-rose-500/50 hover:text-rose-400'
          : 'bg-green-500 hover:bg-green-400 text-black shadow-md shadow-green-950/40'
      }"
      data-did="${actor.did}"
      data-following="${Boolean(isFollowing)}"
      data-follow-uri="${followUri}"
    >
      ${isFollowing ? 'Following' : 'Follow'}
    </button>
  `;

  return el;
}

export async function toggleFollowActor(button) {
  if (!state.agent) return;
  const did = button.dataset.did;
  const isFollowing = button.dataset.following === 'true';
  const followUri = button.dataset.followUri;

  button.disabled = true;

  try {
    if (isFollowing && followUri) {
      await state.agent.deleteFollow(followUri);
      state.followingMap.delete(did);
      button.dataset.following = 'false';
      button.dataset.followUri = '';
      button.textContent = 'Follow';
      button.className = 'btn-follow-toggle px-3.5 py-1.5 rounded-xl text-xs font-bold transition shrink-0 bg-green-500 hover:bg-green-400 text-black shadow-md shadow-green-950/40';
      showToast('Unfollowed account', 'info');
    } else {
      const res = await state.agent.follow(did);
      const newFollowUri = res.uri;
      state.followingMap.set(did, newFollowUri);
      button.dataset.following = 'true';
      button.dataset.followUri = newFollowUri;
      button.textContent = 'Following';
      button.className = 'btn-follow-toggle px-3.5 py-1.5 rounded-xl text-xs font-bold transition shrink-0 bg-neutral-900 hover:bg-neutral-800 text-white border border-neutral-700 hover:border-rose-500/50 hover:text-rose-400';
      showToast('Following account!', 'success');
    }
  } catch (error) {
    console.error('Error toggling follow:', error);
    showToast('Failed to update follow status: ' + formatErrorMessage(error), 'error');
  } finally {
    button.disabled = false;
  }
}

// ==========================================
// Interactions: Like & Repost
// ==========================================

export async function toggleLikePost(button) {
  if (!state.agent) return;
  const uri = button.dataset.uri;
  const cid = button.dataset.cid;
  const isLiked = button.dataset.liked === 'true';
  const likeUri = button.dataset.likeUri;
  const counterEl = button.querySelector('.like-counter');
  let currentCount = parseInt(counterEl?.textContent || '0', 10);

  // Optimistic UI
  button.dataset.liked = (!isLiked).toString();
  const svg = button.querySelector('svg');

  if (isLiked) {
    svg?.classList.remove('fill-current');
    svg?.classList.add('fill-none');
    button.classList.remove('text-green-400');
    if (counterEl) counterEl.textContent = Math.max(0, currentCount - 1) || '';
  } else {
    svg?.classList.remove('fill-none');
    svg?.classList.add('fill-current');
    button.classList.add('text-green-400');
    if (counterEl) counterEl.textContent = (currentCount + 1).toString();
  }

  try {
    if (isLiked && likeUri) {
      await state.agent.deleteLike(likeUri);
      button.dataset.likeUri = '';
    } else {
      const res = await state.agent.like(uri, cid);
      button.dataset.likeUri = res.uri;
    }
  } catch (err) {
    console.error('Error toggling like:', err);
    // Revert optimistic
    button.dataset.liked = isLiked.toString();
    if (isLiked) {
      svg?.classList.add('fill-current');
      button.classList.add('text-green-400');
      if (counterEl) counterEl.textContent = currentCount || '';
    } else {
      svg?.classList.remove('fill-current');
      button.classList.remove('text-green-400');
      if (counterEl) counterEl.textContent = currentCount || '';
    }
    showToast('Like action failed: ' + formatErrorMessage(err), 'error');
  }
}

export async function toggleRepostPost(button) {
  if (!state.agent) return;
  const uri = button.dataset.uri;
  const cid = button.dataset.cid;
  const isReposted = button.dataset.reposted === 'true';
  const repostUri = button.dataset.repostUri;
  const counterEl = button.querySelector('.repost-counter');
  let currentCount = parseInt(counterEl?.textContent || '0', 10);

  // Optimistic UI
  button.dataset.reposted = (!isReposted).toString();
  if (isReposted) {
    button.classList.remove('text-green-400');
    if (counterEl) counterEl.textContent = Math.max(0, currentCount - 1) || '';
  } else {
    button.classList.add('text-green-400');
    if (counterEl) counterEl.textContent = (currentCount + 1).toString();
  }

  try {
    if (isReposted && repostUri) {
      await state.agent.deleteRepost(repostUri);
      button.dataset.repostUri = '';
    } else {
      const res = await state.agent.repost(uri, cid);
      button.dataset.repostUri = res.uri;
      showToast('Reposted to your followers', 'success');
    }
  } catch (err) {
    console.error('Error toggling repost:', err);
    button.dataset.reposted = isReposted.toString();
    if (isReposted) {
      button.classList.add('text-green-400');
      if (counterEl) counterEl.textContent = currentCount || '';
    } else {
      button.classList.remove('text-green-400');
      if (counterEl) counterEl.textContent = currentCount || '';
    }
    showToast('Repost action failed: ' + formatErrorMessage(err), 'error');
  }
}

// ==========================================
// App Navigation & View Switching
// ==========================================

export function switchAppView(viewName) {
  state.activeView = viewName;

  const subviewFeed = document.getElementById('subview-feed');
  const subviewSearch = document.getElementById('subview-search');
  const subviewProfile = document.getElementById('subview-profile');

  // Hide all subviews
  subviewFeed?.classList.add('hidden');
  subviewSearch?.classList.add('hidden');
  subviewProfile?.classList.add('hidden');

  // Show active subview
  if (viewName === 'feed') {
    subviewFeed?.classList.remove('hidden');
  } else if (viewName === 'search') {
    subviewSearch?.classList.remove('hidden');
    document.getElementById('search-input')?.focus();
  } else if (viewName === 'profile') {
    subviewProfile?.classList.remove('hidden');
    loadUserProfile();
    loadFeed('myposts');
  }

  // Update mobile bottom nav active classes
  document.querySelectorAll('.mobile-nav-btn').forEach((btn) => {
    btn.classList.remove('text-green-500');
    btn.classList.add('text-neutral-400');
  });

  const activeNavBtn = document.getElementById(`nav-btn-${viewName}`);
  if (activeNavBtn) {
    activeNavBtn.classList.add('text-green-500');
    activeNavBtn.classList.remove('text-neutral-400');
  }
}

// ==========================================
// UI Helpers, Modals & Toast
// ==========================================

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }
}

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  let borderColor = 'border-neutral-800';
  let textColor = 'text-white';
  let iconSvg = '';

  if (type === 'success') {
    borderColor = 'border-green-500/80';
    textColor = 'text-green-400';
    iconSvg = '<svg class="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
  } else if (type === 'error') {
    borderColor = 'border-rose-600/80';
    textColor = 'text-rose-400';
    iconSvg = '<svg class="w-4 h-4 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
  } else {
    iconSvg = '<svg class="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
  }

  toast.className = `p-3 rounded-xl bg-neutral-950 border ${borderColor} text-xs ${textColor} shadow-2xl flex items-center gap-2 transform translate-y-2 opacity-0 transition duration-200 pointer-events-auto max-w-xs`;
  toast.innerHTML = `${iconSvg}<span class="flex-1">${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function setAuthLoading(loading, message = '') {
  const statusBox = document.getElementById('auth-status-text');
  const statusLabel = document.getElementById('auth-status-label');
  const loginBtn = document.getElementById('btn-login-submit');
  const signupBtn = document.getElementById('btn-signup-submit');

  if (loading) {
    if (statusBox) statusBox.classList.remove('hidden');
    if (statusLabel) statusLabel.textContent = message;
    loginBtn?.setAttribute('disabled', 'true');
    signupBtn?.setAttribute('disabled', 'true');
    loginBtn?.querySelectorAll('.btn-spinner').forEach((s) => s.classList.remove('hidden'));
    signupBtn?.querySelectorAll('.btn-spinner').forEach((s) => s.classList.remove('hidden'));
  } else {
    if (statusBox) statusBox.classList.add('hidden');
    loginBtn?.removeAttribute('disabled');
    signupBtn?.removeAttribute('disabled');
    loginBtn?.querySelectorAll('.btn-spinner').forEach((s) => s.classList.add('hidden'));
    signupBtn?.querySelectorAll('.btn-spinner').forEach((s) => s.classList.add('hidden'));
  }
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

function showAuthSuccessNotice(msg) {
  const statusBox = document.getElementById('auth-status-text');
  const statusLabel = document.getElementById('auth-status-label');
  if (statusBox && statusLabel) {
    statusLabel.textContent = msg;
    statusBox.classList.remove('hidden');
  }
}

function setPublishButtonLoading(loading) {
  const buttons = document.querySelectorAll('.btn-publish-trigger');
  buttons.forEach((btn) => {
    if (loading) {
      btn.setAttribute('disabled', 'true');
      btn.querySelector('.btn-spinner')?.classList.remove('hidden');
    } else {
      btn.removeAttribute('disabled');
      btn.querySelector('.btn-spinner')?.classList.add('hidden');
    }
  });
}

function updateCharCounter() {
  const inlineVal = document.getElementById('composer-textarea')?.value || '';
  const modalVal = document.getElementById('modal-composer-textarea')?.value || '';

  const inlineCount = 300 - inlineVal.length;
  const modalCount = 300 - modalVal.length;

  const inlineCounterEl = document.getElementById('composer-char-count');
  if (inlineCounterEl) {
    inlineCounterEl.textContent = inlineCount;
    inlineCounterEl.className = inlineCount < 0 ? 'text-xs font-mono text-rose-500 font-bold' : 'text-xs font-mono text-neutral-500';
  }

  const modalCounterEl = document.getElementById('modal-char-count');
  if (modalCounterEl) {
    modalCounterEl.textContent = modalCount;
    modalCounterEl.className = modalCount < 0 ? 'text-xs font-mono text-rose-500 font-bold' : 'text-xs font-mono text-neutral-500';
  }
}

function updatePdsBadgeUI(endpoint) {
  const badge = document.getElementById('active-pds-badge');
  if (badge) {
    try {
      const url = new URL(endpoint);
      badge.textContent = url.hostname;
    } catch {
      badge.textContent = endpoint;
    }
  }
}

function showSplashMessage(msg) {
  const splash = document.getElementById('splash-screen');
  const text = document.getElementById('splash-text');
  if (splash) splash.classList.remove('hidden');
  if (text) text.textContent = msg;
}

function hideSplashScreen() {
  const splash = document.getElementById('splash-screen');
  if (splash) splash.classList.add('hidden');
}

function formatErrorMessage(error) {
  if (!error) return 'An unexpected network error occurred.';
  const msg = error.message || error.toString();
  if (msg.includes('Authentication Required') || msg.includes('Invalid identifier or password')) {
    return 'Invalid handle/email or password. Please verify your credentials.';
  }
  if (msg.includes('Handle not found') || msg.includes('Unable to resolve handle')) {
    return 'Could not locate that handle on postersocial.app or the AT Protocol network.';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return 'Network connection issue or PDS is unreachable. Verify your connection to postersocial.app.';
  }
  if (msg.includes('Token has expired') || msg.includes('ExpiredToken')) {
    return 'Session expired. Please sign in again.';
  }
  return msg;
}

function formatTimeAgo(isoString) {
  const now = Date.now();
  const past = new Date(isoString).getTime();
  const diffSec = Math.floor((now - past) / 1000);

  if (diffSec < 60) return `${Math.max(1, diffSec)}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function linkifyText(escapedText) {
  // URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let linked = escapedText.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-green-400 hover:underline">${url}</a>`;
  });

  // Mentions
  const mentionRegex = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  linked = linked.replace(mentionRegex, (match) => {
    return `<span class="text-green-400 font-mono font-medium">${match}</span>`;
  });

  return linked;
}

// ==========================================
// Event Listeners & Initialization
// ==========================================

export function initEventListeners() {
  const formLogin = document.getElementById('form-login');
  const formSignup = document.getElementById('form-signup');
  const tabBtnLogin = document.getElementById('tab-btn-login');
  const tabBtnSignup = document.getElementById('tab-btn-signup');

  // 1. Auth Mode Switcher (Login vs Signup)
  tabBtnLogin?.addEventListener('click', () => {
    clearAuthError();
    formLogin?.classList.remove('hidden');
    formSignup?.classList.add('hidden');
    tabBtnLogin.className = 'py-2 rounded-lg bg-neutral-900 text-white border border-neutral-800 shadow transition';
    if (tabBtnSignup) tabBtnSignup.className = 'py-2 rounded-lg text-neutral-400 hover:text-white transition';
  });

  tabBtnSignup?.addEventListener('click', () => {
    clearAuthError();
    formSignup?.classList.remove('hidden');
    formLogin?.classList.add('hidden');
    tabBtnSignup.className = 'py-2 rounded-lg bg-neutral-900 text-white border border-neutral-800 shadow transition';
    if (tabBtnLogin) tabBtnLogin.className = 'py-2 rounded-lg text-neutral-400 hover:text-white transition';
  });

  // 2. Quick Suffix Helper Chips
  document.querySelectorAll('.btn-suffix-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const targetInput = document.getElementById(chip.dataset.targetInput);
      const suffix = chip.dataset.suffix;
      if (targetInput) {
        let val = targetInput.value.trim();
        val = val.replace(/\.(postersocial\.app|bsky\.social)$/, '');
        targetInput.value = val ? `${val}${suffix}` : '';
        targetInput.focus();
      }
    });
  });

  // 3. Login Form Submission (hardcoded target: https://postersocial.app)
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

  // 4. Signup Form Submission targeting https://postersocial.app (invite code disabled)
  if (formSignup) {
    formSignup.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const email = document.getElementById('signup-email')?.value || '';
      const handle = document.getElementById('signup-handle')?.value || '';
      const password = document.getElementById('signup-password')?.value || '';

      if (!email.trim() || !email.includes('@')) {
        showAuthError('Please enter a valid email address.');
        return;
      }
      if (!handle.trim()) {
        showAuthError('Please enter your desired handle.');
        return;
      }
      if (!password || password.length < 8) {
        showAuthError('Password must be at least 8 characters in length.');
        return;
      }

      await signupUser(email, handle, password);
    });
  }

  // 5. Navigation: Top bar & Mobile Bottom Bar
  document.getElementById('nav-btn-home-logo')?.addEventListener('click', () => switchAppView('feed'));
  document.getElementById('top-btn-search')?.addEventListener('click', () => switchAppView('search'));
  document.getElementById('top-btn-profile')?.addEventListener('click', () => switchAppView('profile'));

  document.getElementById('nav-btn-feed')?.addEventListener('click', () => switchAppView('feed'));
  document.getElementById('nav-btn-search')?.addEventListener('click', () => switchAppView('search'));
  document.getElementById('nav-btn-profile')?.addEventListener('click', () => switchAppView('profile'));

  // 6. Feed Tabs (Timeline vs My Posts)
  const feedTabTimeline = document.getElementById('feed-tab-timeline');
  const feedTabMyPosts = document.getElementById('feed-tab-myposts');

  feedTabTimeline?.addEventListener('click', () => {
    feedTabTimeline.className = 'flex-1 py-3 text-center border-b-2 border-green-500 text-white transition';
    if (feedTabMyPosts) feedTabMyPosts.className = 'flex-1 py-3 text-center border-b-2 border-transparent text-neutral-400 hover:text-white transition';
    loadFeed('timeline');
  });

  feedTabMyPosts?.addEventListener('click', () => {
    feedTabMyPosts.className = 'flex-1 py-3 text-center border-b-2 border-green-500 text-white transition';
    if (feedTabTimeline) feedTabTimeline.className = 'flex-1 py-3 text-center border-b-2 border-transparent text-neutral-400 hover:text-white transition';
    loadFeed('myposts');
  });

  // 7. Profile Subtabs (My Posts vs Server Info)
  const profSubtabPosts = document.getElementById('profile-subtab-posts');
  const profSubtabServer = document.getElementById('profile-subtab-server');
  const profPostsContainer = document.getElementById('profile-posts-container');
  const profServerContainer = document.getElementById('profile-server-container');

  profSubtabPosts?.addEventListener('click', () => {
    profSubtabPosts.className = 'flex-1 py-3 text-center border-b-2 border-green-500 text-white transition';
    if (profSubtabServer) profSubtabServer.className = 'flex-1 py-3 text-center border-b-2 border-transparent text-neutral-400 hover:text-white transition';
    profPostsContainer?.classList.remove('hidden');
    profServerContainer?.classList.add('hidden');
    loadFeed('myposts');
  });

  profSubtabServer?.addEventListener('click', () => {
    profSubtabServer.className = 'flex-1 py-3 text-center border-b-2 border-green-500 text-white transition';
    if (profSubtabPosts) profSubtabPosts.className = 'flex-1 py-3 text-center border-b-2 border-transparent text-neutral-400 hover:text-white transition';
    profPostsContainer?.classList.add('hidden');
    profServerContainer?.classList.remove('hidden');
  });

  // 8. Refresh Feed
  document.getElementById('btn-refresh-feed')?.addEventListener('click', () => {
    loadFeed(state.activeFeedTab);
  });

  // 9. Logout Triggers
  document.querySelectorAll('.btn-logout-trigger').forEach((btn) => {
    btn.addEventListener('click', logoutUser);
  });

  // 10. Composer Modal Open / Close
  document.querySelectorAll('.btn-open-composer').forEach((btn) => {
    btn.addEventListener('click', () => openModal('composer-modal'));
  });
  document.getElementById('btn-close-composer')?.addEventListener('click', () => closeModal('composer-modal'));

  // 11. Character Counters
  document.getElementById('composer-textarea')?.addEventListener('input', updateCharCounter);
  document.getElementById('modal-composer-textarea')?.addEventListener('input', updateCharCounter);

  // 12. Inline Media Pickers (Photos & Video)
  const inlineFileImages = document.getElementById('inline-file-images');
  const inlineFileVideo = document.getElementById('inline-file-video');

  document.getElementById('btn-inline-add-photo')?.addEventListener('click', () => inlineFileImages?.click());
  document.getElementById('btn-inline-add-video')?.addEventListener('click', () => inlineFileVideo?.click());

  inlineFileImages?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      state.inlineImages = [...state.inlineImages, ...Array.from(e.target.files)].slice(0, 4);
      renderComposerAttachments('inline');
    }
  });

  inlineFileVideo?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      state.inlineVideo = e.target.files[0];
      renderComposerAttachments('inline');
    }
  });

  document.getElementById('btn-inline-remove-video')?.addEventListener('click', () => {
    state.inlineVideo = null;
    if (inlineFileVideo) inlineFileVideo.value = '';
    renderComposerAttachments('inline');
  });

  // 13. Modal Media Pickers (Photos & Video)
  const modalFileImages = document.getElementById('modal-file-images');
  const modalFileVideo = document.getElementById('modal-file-video');

  document.getElementById('btn-modal-add-photo')?.addEventListener('click', () => modalFileImages?.click());
  document.getElementById('btn-modal-add-video')?.addEventListener('click', () => modalFileVideo?.click());

  modalFileImages?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      state.modalImages = [...state.modalImages, ...Array.from(e.target.files)].slice(0, 4);
      renderComposerAttachments('modal');
    }
  });

  modalFileVideo?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      state.modalVideo = e.target.files[0];
      renderComposerAttachments('modal');
    }
  });

  document.getElementById('btn-modal-remove-video')?.addEventListener('click', () => {
    state.modalVideo = null;
    if (modalFileVideo) modalFileVideo.value = '';
    renderComposerAttachments('modal');
  });

  // Remove individual photo attachment
  document.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.btn-remove-img');
    if (removeBtn) {
      const context = removeBtn.dataset.context;
      const index = parseInt(removeBtn.dataset.index, 10);
      if (context === 'inline') {
        state.inlineImages.splice(index, 1);
        renderComposerAttachments('inline');
      } else {
        state.modalImages.splice(index, 1);
        renderComposerAttachments('modal');
      }
    }
  });

  // 14. Publish Post Triggers
  document.getElementById('btn-inline-publish')?.addEventListener('click', () => {
    const text = document.getElementById('composer-textarea')?.value || '';
    publishPost({
      text,
      images: state.inlineImages,
      video: state.inlineVideo,
    });
  });

  document.getElementById('btn-modal-publish')?.addEventListener('click', () => {
    const text = document.getElementById('modal-composer-textarea')?.value || '';
    publishPost({
      text,
      images: state.modalImages,
      video: state.modalVideo,
    });
  });

  // 15. Search Input with Debounce
  const searchInput = document.getElementById('search-input');
  const searchClearBtn = document.getElementById('search-clear-btn');
  let searchTimeout = null;

  searchInput?.addEventListener('input', (e) => {
    const q = e.target.value;
    if (q) {
      searchClearBtn?.classList.remove('hidden');
    } else {
      searchClearBtn?.classList.add('hidden');
    }

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchAccounts(q);
    }, 350);
  });

  searchClearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchClearBtn.classList.add('hidden');
    searchAccounts('');
  });

  document.querySelectorAll('.search-tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.query;
      if (searchInput) {
        searchInput.value = tag;
        searchClearBtn?.classList.remove('hidden');
        searchAccounts(tag);
      }
    });
  });

  // 16. Follow / Unfollow Delegate
  document.addEventListener('click', (e) => {
    const followBtn = e.target.closest('.btn-follow-toggle');
    if (followBtn) {
      toggleFollowActor(followBtn);
    }
  });

  // 17. Like, Repost & Share Delegates on Posts
  document.addEventListener('click', (e) => {
    const likeBtn = e.target.closest('.btn-post-like');
    if (likeBtn) {
      e.preventDefault();
      toggleLikePost(likeBtn);
      return;
    }

    const repostBtn = e.target.closest('.btn-post-repost');
    if (repostBtn) {
      e.preventDefault();
      toggleRepostPost(repostBtn);
      return;
    }

    const shareBtn = e.target.closest('.btn-post-share');
    if (shareBtn) {
      e.preventDefault();
      const author = shareBtn.dataset.author;
      const rkey = shareBtn.dataset.rkey;
      const postUrl = `https://postersocial.app/profile/${author}/post/${rkey}`;

      if (navigator.share) {
        navigator.share({
          title: `Post on Postr Social (@${author})`,
          text: `Check out this post on Postr Social:`,
          url: postUrl,
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(postUrl).then(() => {
          showToast('Post link copied to clipboard!', 'success');
        }).catch(() => {
          showToast('Could not copy link', 'error');
        });
      }
    }
  });

  // 18. Profile Editing Modal & Avatar Picker
  document.getElementById('btn-open-edit-profile')?.addEventListener('click', () => {
    if (state.profile) {
      renderUserProfileUI(state.profile);
    }
    openModal('edit-profile-modal');
  });
  document.getElementById('btn-close-edit-profile')?.addEventListener('click', () => closeModal('edit-profile-modal'));
  document.getElementById('btn-cancel-edit-profile')?.addEventListener('click', () => closeModal('edit-profile-modal'));

  const avatarFileInput = document.getElementById('profile-avatar-file-input');
  document.getElementById('btn-trigger-avatar-change')?.addEventListener('click', () => avatarFileInput?.click());
  document.getElementById('btn-edit-avatar-picker')?.addEventListener('click', () => avatarFileInput?.click());

  avatarFileInput?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      state.pendingAvatarFile = file;
      const previewImg = document.getElementById('edit-profile-avatar-preview');
      if (previewImg) {
        previewImg.src = URL.createObjectURL(file);
      }
    }
  });

  document.getElementById('edit-bio')?.addEventListener('input', (e) => {
    const len = e.target.value.length;
    const charCountEl = document.getElementById('edit-bio-char-count');
    if (charCountEl) charCountEl.textContent = 256 - len;
  });

  document.getElementById('form-edit-profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const displayName = document.getElementById('edit-display-name')?.value || '';
    const description = document.getElementById('edit-bio')?.value || '';

    await saveProfileChanges({
      displayName,
      description,
      avatarFile: state.pendingAvatarFile,
    });
  });

  // 19. PWA Install Prompts (Chromium & iOS)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    document.querySelectorAll('.pwa-install-trigger').forEach((btn) => btn.classList.remove('hidden'));
  });

  document.querySelectorAll('.pwa-install-trigger').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (state.deferredInstallPrompt) {
        state.deferredInstallPrompt.prompt();
        const { outcome } = await state.deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          showToast('Thank you for installing Postr Social!', 'success');
          document.querySelectorAll('.pwa-install-trigger').forEach((b) => b.classList.add('hidden'));
        }
        state.deferredInstallPrompt = null;
      } else {
        // Show iOS guide if on iOS or unsupported
        openModal('pwa-ios-modal');
      }
    });
  });

  document.getElementById('pwa-ios-close')?.addEventListener('click', () => closeModal('pwa-ios-modal'));

  // 20. Online / Offline Connectivity Monitor
  window.addEventListener('online', () => {
    state.isOnline = true;
    document.getElementById('offline-indicator')?.classList.add('hidden');
    showToast('Internet connection restored.', 'success');
    if (state.session) loadFeed(state.activeFeedTab);
  });

  window.addEventListener('offline', () => {
    state.isOnline = false;
    document.getElementById('offline-indicator')?.classList.remove('hidden');
    showToast('You are currently offline.', 'info');
  });

  if (!navigator.onLine) {
    document.getElementById('offline-indicator')?.classList.remove('hidden');
  }
}

// ==========================================
// Bootstrap Application
// ==========================================
async function bootstrapApp() {
  initEventListeners();
  const resumed = await resumeExistingSession();
  if (!resumed) {
    document.getElementById('auth-view')?.classList.remove('hidden');
    document.getElementById('dashboard-view')?.classList.add('hidden');
    document.getElementById('mobile-bottom-nav')?.classList.add('hidden');
  }
}

// Kick off when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
