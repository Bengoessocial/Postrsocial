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
  isDemo: false,
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

  // Composer attachments & quote state
  inlineImages: [],
  inlineVideo: null,
  modalImages: [],
  modalVideo: null,
  activeQuotedPost: null,
  activeRepostPost: null,

  // Thread and comments state
  activeThreadPost: null,
  commentsByPostUri: {},

  // Deletion target state
  deleteTarget: null,

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

// Helper to read file as base64 data URL
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function getDemoProfile() {
  return {
    did: 'did:plc:demo123postrsocial',
    handle: 'alex.postersocial.app',
    displayName: 'Alex Rivera',
    description: 'Exploring the AT Protocol federated social web on postersocial.app 🚀 Web developer, open standards enthusiast.',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200&auto=format&fit=crop&q=80',
    banner: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1000&auto=format&fit=crop&q=80',
    postsCount: 2,
    followersCount: 148,
    followsCount: 92,
  };
}

export function getInitialDemoComments() {
  return {
    'at://did:plc:postr001/app.bsky.feed.post/demo1': [
      {
        id: 'comm_init_1',
        uri: 'at://did:plc:sophia456/app.bsky.feed.post/demo1_c1',
        author: {
          did: 'did:plc:sophia456',
          handle: 'sophia.postersocial.app',
          displayName: 'Sophia Chen',
          avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&auto=format&fit=crop&q=80',
        },
        text: 'The UI feels amazingly responsive and sleek! Loving the instant loading and dark theme on mobile.',
        createdAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
        likeCount: 6,
        viewer: { like: null },
      },
      {
        id: 'comm_init_2',
        uri: 'at://did:plc:marcus789/app.bsky.feed.post/demo1_c2',
        author: {
          did: 'did:plc:marcus789',
          handle: 'marcus.postersocial.app',
          displayName: 'Marcus Brody',
          avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&auto=format&fit=crop&q=80',
        },
        text: 'Great to see postersocial.app adopting ATProto so natively. Federated social networking done right.',
        createdAt: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
        likeCount: 4,
        viewer: { like: null },
      },
    ],
    'at://did:plc:sophia456/app.bsky.feed.post/demo3': [
      {
        id: 'comm_init_3',
        uri: 'at://did:plc:elena321/app.bsky.feed.post/demo3_c1',
        author: {
          did: 'did:plc:elena321',
          handle: 'elena.postersocial.app',
          displayName: 'Elena Rostova',
          avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=200&auto=format&fit=crop&q=80',
        },
        text: 'Stunning colors in that sunset shot! Golden hour lighting is magical ✨',
        createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
        likeCount: 3,
        viewer: { like: null },
      },
    ],
  };
}

export function getDemoFeed() {
  return [
    {
      post: {
        uri: 'at://did:plc:marcus789/app.bsky.feed.post/demo5',
        cid: 'bafy005',
        author: {
          did: 'did:plc:marcus789',
          handle: 'marcus.postersocial.app',
          displayName: 'Marcus Brody',
          avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&auto=format&fit=crop&q=80',
        },
        record: {
          text: 'Big milestone for the AT Protocol ecosystem! Really excited to see postersocial.app launch as a federated personal data server 🚀',
          createdAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
          quote: {
            uri: 'at://did:plc:postr001/app.bsky.feed.post/demo1',
            cid: 'bafy001',
            author: {
              did: 'did:plc:postr001',
              handle: 'postr.postersocial.app',
              displayName: 'Postr Social Official',
              avatar: '/icon.svg',
            },
            text: 'Welcome to Postr Social (postersocial.app)! Built on the AT Protocol, this modern Progressive Web App brings federated, user-owned social networking directly to your mobile screen and desktop.',
            createdAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
          },
        },
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: {
            uri: 'at://did:plc:postr001/app.bsky.feed.post/demo1',
            cid: 'bafy001',
            author: {
              did: 'did:plc:postr001',
              handle: 'postr.postersocial.app',
              displayName: 'Postr Social Official',
              avatar: '/icon.svg',
            },
            value: {
              text: 'Welcome to Postr Social (postersocial.app)! Built on the AT Protocol, this modern Progressive Web App brings federated, user-owned social networking directly to your mobile screen and desktop.',
              createdAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
            },
          },
        },
        replyCount: 2,
        repostCount: 7,
        likeCount: 42,
        viewer: { like: null, repost: null },
      },
    },
    {
      post: {
        uri: 'at://did:plc:postr001/app.bsky.feed.post/demo1',
        cid: 'bafy001',
        author: {
          did: 'did:plc:postr001',
          handle: 'postr.postersocial.app',
          displayName: 'Postr Social Official',
          avatar: '/icon.svg',
        },
        record: {
          text: 'Welcome to Postr Social (postersocial.app)! 🎉\n\nBuilt on the AT Protocol, this modern Progressive Web App brings federated, user-owned social networking directly to your mobile screen and desktop.',
          createdAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
        },
        replyCount: 5,
        repostCount: 18,
        likeCount: 64,
        viewer: { like: null, repost: null },
      },
    },
    {
      post: {
        uri: 'at://did:plc:demo123postrsocial/app.bsky.feed.post/demo2',
        cid: 'bafy002',
        author: {
          did: 'did:plc:demo123postrsocial',
          handle: 'alex.postersocial.app',
          displayName: 'Alex Rivera',
          avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200&auto=format&fit=crop&q=80',
        },
        record: {
          text: 'Just set up my home PDS on postersocial.app! The interface is ultra fast, dark themed, and clean. Loving the federated social web experience.',
          createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
        },
        replyCount: 2,
        repostCount: 4,
        likeCount: 29,
        viewer: { like: null, repost: null },
      },
    },
    {
      post: {
        uri: 'at://did:plc:sophia456/app.bsky.feed.post/demo3',
        cid: 'bafy003',
        author: {
          did: 'did:plc:sophia456',
          handle: 'sophia.postersocial.app',
          displayName: 'Sophia Chen',
          avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&auto=format&fit=crop&q=80',
        },
        record: {
          text: 'Sunset view from the hills tonight ✨ Photography and decentralized networking are a wonderful mix.',
          createdAt: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
        },
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [
            {
              thumb: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&auto=format&fit=crop&q=80',
              fullsize: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1600&auto=format&fit=crop&q=80',
              alt: 'Golden hour sunset over rolling hills',
            },
          ],
        },
        replyCount: 8,
        repostCount: 12,
        likeCount: 104,
        viewer: { like: null, repost: null },
      },
    },
    {
      post: {
        uri: 'at://did:plc:demo123postrsocial/app.bsky.feed.post/demo4',
        cid: 'bafy004',
        author: {
          did: 'did:plc:demo123postrsocial',
          handle: 'alex.postersocial.app',
          displayName: 'Alex Rivera',
          avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200&auto=format&fit=crop&q=80',
        },
        record: {
          text: 'Testing the post composer with mentions @postr.postersocial.app. Everything syncs smoothly in this PWA!',
          createdAt: new Date(Date.now() - 1000 * 60 * 600).toISOString(),
        },
        replyCount: 1,
        repostCount: 3,
        likeCount: 14,
        viewer: { like: null, repost: null },
      },
    },
  ];
}

export const DEMO_ACTORS = [
  {
    did: 'did:plc:postr001',
    handle: 'postr.postersocial.app',
    displayName: 'Postr Social Official',
    avatar: '/icon.svg',
    description: 'Official announcements and updates from the Postr Social PDS team.',
    viewer: { following: null },
  },
  {
    did: 'did:plc:sophia456',
    handle: 'sophia.postersocial.app',
    displayName: 'Sophia Chen',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&auto=format&fit=crop&q=80',
    description: 'Photographer, explorer, and design lead at postersocial.app.',
    viewer: { following: null },
  },
  {
    did: 'did:plc:marcus789',
    handle: 'marcus.postersocial.app',
    displayName: 'Marcus Brody',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&auto=format&fit=crop&q=80',
    description: 'Protocol engineer building ATProto PDS relays and federated apps.',
    viewer: { following: null },
  },
  {
    did: 'did:plc:elena321',
    handle: 'elena.postersocial.app',
    displayName: 'Elena Rostova',
    avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=200&auto=format&fit=crop&q=80',
    description: 'Product designer & digital artist. Exploring the decentralised future.',
    viewer: { following: null },
  },
];

export async function enterDemoMode() {
  state.isDemo = true;
  state.agent = null;
  state.session = {
    handle: 'alex.postersocial.app',
    did: 'did:plc:demo123postrsocial',
    accessJwt: 'demo_token',
  };
  state.profile = getDemoProfile();
  state.feed = getDemoFeed();
  state.commentsByPostUri = getInitialDemoComments();
  saveSession(state.session, POSTR_CONFIG.pdsHost, true);
  await onAuthSuccess();
  showToast('Welcome to Postr Social Demo!', 'success');
}

export async function resumeExistingSession() {
  const stored = localStorage.getItem(POSTR_CONFIG.sessionKey);
  if (!stored) return false;

  try {
    const data = JSON.parse(stored);
    if (!data.session) return false;

    if (data.isDemo) {
      state.isDemo = true;
      state.session = data.session;
      state.profile = data.profile || getDemoProfile();
      state.feed = data.feed || getDemoFeed();
      state.commentsByPostUri = data.comments || getInitialDemoComments();
      state.pdsEndpoint = data.pdsEndpoint || POSTR_CONFIG.pdsHost;
      await onAuthSuccess();
      return true;
    }

    if (!data.session.accessJwt) return false;

    showSplashMessage('Resuming Postr session...');
    const agent = new BskyAgent({ service: data.pdsEndpoint || POSTR_CONFIG.pdsHost });
    await agent.resumeSession(data.session);

    state.agent = agent;
    state.session = agent.session;
    state.pdsEndpoint = data.pdsEndpoint || POSTR_CONFIG.pdsHost;
    state.commentsByPostUri = data.comments || {};

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
  state.isDemo = false;
  state.agent = null;
  state.session = null;
  state.profile = null;
  state.feed = [];
  state.activeQuotedPost = null;
  state.activeRepostPost = null;
  state.activeThreadPost = null;
  state.commentsByPostUri = {};
  state.deleteTarget = null;
  state.followingMap.clear();

  document.getElementById('auth-view')?.classList.remove('hidden');
  document.getElementById('dashboard-view')?.classList.add('hidden');
  document.getElementById('mobile-bottom-nav')?.classList.add('hidden');
  switchAppView('feed');
  showToast('Logged out of Postr Social', 'info');
}

function saveSession(session, pdsEndpoint, isDemo = false) {
  try {
    localStorage.setItem(
      POSTR_CONFIG.sessionKey,
      JSON.stringify({
        session,
        pdsEndpoint,
        isDemo,
        profile: state.profile,
        feed: state.feed,
        comments: state.commentsByPostUri,
      })
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
  if (state.isDemo) {
    if (!state.profile) {
      state.profile = getDemoProfile();
    }
    renderUserProfileUI(state.profile);
    return;
  }

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
  const saveBtn = document.getElementById('btn-save-profile');
  const spinner = document.getElementById('save-profile-spinner');
  if (saveBtn) saveBtn.disabled = true;
  if (spinner) spinner.classList.remove('hidden');

  try {
    if (state.isDemo) {
      let avatarUrl = state.profile?.avatar || '/icon.svg';
      if (avatarFile) {
        avatarUrl = await readFileAsDataURL(avatarFile);
      }
      state.profile = {
        ...(state.profile || getDemoProfile()),
        displayName: displayName.trim() || state.profile?.displayName || 'Postr User',
        description: description.trim(),
        avatar: avatarUrl,
      };
      saveSession(state.session, state.pdsEndpoint, true);
      renderUserProfileUI(state.profile);
      state.pendingAvatarFile = null;
      closeModal('edit-profile-modal');
      showToast('Profile updated successfully!', 'success');
      return;
    }

    if (!state.agent) throw new Error('Agent not authenticated');

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

  if (state.isDemo) {
    if (!state.feed || state.feed.length === 0) {
      state.feed = getDemoFeed();
    }
    let posts = [];
    if (tab === 'timeline') {
      posts = state.feed;
    } else {
      posts = state.feed.filter((item) => item.post?.author?.did === state.session?.did);
    }
    setTimeout(() => {
      renderFeedList(posts, targetContainer);
      if (profilePostsContainer && targetContainer !== profilePostsContainer && tab === 'myposts') {
        renderFeedList(posts, profilePostsContainer);
      }
      state.isRefreshingFeed = false;
      if (refreshSpinner) refreshSpinner.classList.add('hidden');
    }, 150);
    return;
  }

  if (!state.agent) return;

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
  card.className = 'p-4 hover:bg-neutral-950/70 transition border-b border-neutral-900 flex gap-3 text-white cursor-pointer group/card';
  card.dataset.uri = post.uri;
  card.dataset.cid = post.cid;

  const author = post.author || {};
  const record = post.record || {};
  const textContent = record.text || '';
  const createdAt = record.createdAt ? formatTimeAgo(record.createdAt) : '';

  // Check if post belongs to logged-in user (or demo user)
  const isOwnPost =
    (state.session?.did && author.did === state.session.did) ||
    (state.isDemo && (author.did === state.session?.did || author.handle === state.session?.handle));

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

  // Embed rendering (Images, Video, External, or Quoted Post)
  const embedHtml = renderPostEmbed(post.embed, post.record);

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
            <div class="flex items-center gap-1.5 shrink-0">
              <time class="text-[11px] text-neutral-400 font-mono">${createdAt}</time>
              ${
                isOwnPost
                  ? `
                <button
                  type="button"
                  class="btn-post-delete p-1 rounded-lg text-neutral-500 hover:text-rose-400 hover:bg-neutral-900 transition"
                  data-uri="${post.uri}"
                  title="Delete Post"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                  </svg>
                </button>
              `
                  : ''
              }
            </div>
          </div>

          <!-- Post Content Text -->
          <div class="mt-1.5 text-sm text-neutral-100 whitespace-pre-wrap break-words leading-relaxed">
            ${linkifyText(escapeHtml(textContent))}
          </div>

          <!-- Embed Preview (Photos, Video, Quote Card) -->
          ${embedHtml}

          <!-- Post Interaction Buttons (Reply, Repost, Like, Share) -->
          <div class="mt-3 pt-2 flex items-center justify-between text-neutral-400 text-xs max-w-md">
            <!-- Reply / Comments Button -->
            <button
              class="btn-post-reply flex items-center gap-1.5 hover:text-green-400 transition cursor-pointer"
              data-uri="${post.uri}"
              data-cid="${post.cid}"
              title="Comments & Replies"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
              <span>${replyCount > 0 ? replyCount : ''}</span>
            </button>

            <!-- Repost / Quote Button -->
            <button
              class="btn-post-repost flex items-center gap-1.5 ${isReposted ? 'text-green-400' : 'hover:text-green-400'} transition cursor-pointer"
              data-reposted="${isReposted}"
              data-repost-uri="${repostUri}"
              data-uri="${post.uri}"
              data-cid="${post.cid}"
              title="Repost or Quote"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              <span class="repost-counter">${repostCount > 0 ? repostCount : ''}</span>
            </button>

            <!-- Like Button -->
            <button
              class="btn-post-like flex items-center gap-1.5 ${isLiked ? 'text-green-400' : 'hover:text-green-400'} transition cursor-pointer"
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

            <!-- Share Link Button -->
            <button
              class="btn-post-share flex items-center gap-1.5 hover:text-green-400 transition cursor-pointer"
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

function renderPostEmbed(embed, record) {
  let outputHtml = '';

  // 1. Quoted Post in record
  if (record && record.quote) {
    const q = record.quote;
    const qTime = q.createdAt ? formatTimeAgo(q.createdAt) : '';
    const qAuthor = q.author || {};
    outputHtml += `
      <div class="mt-2.5 p-3 rounded-xl border border-neutral-800 bg-neutral-900/60 hover:border-green-500/40 transition cursor-pointer quoted-post-card" data-uri="${q.uri || ''}">
        <div class="flex items-center gap-2 mb-1.5">
          <img src="${qAuthor.avatar || '/icon.svg'}" class="w-5 h-5 rounded-full object-cover border border-neutral-800" alt="" />
          <span class="text-xs font-bold text-white truncate">${escapeHtml(qAuthor.displayName || qAuthor.handle || 'User')}</span>
          <span class="text-[11px] text-neutral-400 font-mono truncate">@${escapeHtml(qAuthor.handle || '')}</span>
          ${qTime ? `<span class="text-[10px] text-neutral-500 ml-auto font-mono">${qTime}</span>` : ''}
        </div>
        <p class="text-xs text-neutral-200 line-clamp-3 leading-relaxed">${linkifyText(escapeHtml(q.text || ''))}</p>
      </div>
    `;
  }

  if (!embed) return outputHtml;

  // 2. Images Embed (app.bsky.embed.images#view)
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

    outputHtml += `<div class="mt-2.5 grid ${gridCols} gap-2 rounded-xl overflow-hidden">${imgsHtml}</div>`;
  }

  // 3. Video Embed (app.bsky.embed.video#view or external)
  if (embed.$type === 'app.bsky.embed.video#view') {
    const playlistUrl = embed.playlist || '';
    const thumbnail = embed.thumbnail || '';
    outputHtml += `
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

  // 4. External link card (app.bsky.embed.external#view)
  if (embed.$type === 'app.bsky.embed.external#view' && embed.external) {
    const ext = embed.external;
    outputHtml += `
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

  // 5. Quoted Post Record Embed (app.bsky.embed.record#view or app.bsky.embed.record)
  if (
    !record?.quote &&
    (embed.$type === 'app.bsky.embed.record#view' || embed.$type === 'app.bsky.embed.record' || (embed.record && !embed.media))
  ) {
    const rec = embed.record?.value || embed.record?.record || embed.record || {};
    const qAuthor = embed.record?.author || rec.author || {};
    const qText = rec.text || embed.record?.text || '';
    const qTime = rec.createdAt ? formatTimeAgo(rec.createdAt) : '';
    const qUri = embed.record?.uri || rec.uri || '';

    outputHtml += `
      <div class="mt-2.5 p-3 rounded-xl border border-neutral-800 bg-neutral-900/60 hover:border-green-500/40 transition cursor-pointer quoted-post-card" data-uri="${qUri}">
        <div class="flex items-center gap-2 mb-1.5">
          <img src="${qAuthor.avatar || '/icon.svg'}" class="w-5 h-5 rounded-full object-cover border border-neutral-800" alt="" />
          <span class="text-xs font-bold text-white truncate">${escapeHtml(qAuthor.displayName || qAuthor.handle || 'User')}</span>
          <span class="text-[11px] text-neutral-400 font-mono truncate">@${escapeHtml(qAuthor.handle || '')}</span>
          ${qTime ? `<span class="text-[10px] text-neutral-500 ml-auto font-mono">${qTime}</span>` : ''}
        </div>
        <p class="text-xs text-neutral-200 line-clamp-3 leading-relaxed">${linkifyText(escapeHtml(qText))}</p>
      </div>
    `;
  }

  // 6. Record with media (Media + Quoted Record)
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view' || embed.$type === 'app.bsky.embed.recordWithMedia') {
    if (embed.media) outputHtml += renderPostEmbed(embed.media, record);
    if (embed.record) outputHtml += renderPostEmbed(embed.record, record);
  }

  return outputHtml;
}

// ==========================================
// Post Composer: Text, Photo & Video uploads
// ==========================================

export async function publishPost({ text, images = [], video = null }) {
  if (state.isPublishingPost) return;

  const trimmedText = text.trim();
  const quoted = state.activeQuotedPost;

  if (!trimmedText && images.length === 0 && !video && !quoted) {
    throw new Error('Please enter some text, attach media, or quote a post.');
  }

  state.isPublishingPost = true;
  setPublishButtonLoading(true);

  try {
    if (state.isDemo) {
      const processedImages = [];
      for (const file of images) {
        const dataUrl = await readFileAsDataURL(file);
        processedImages.push({
          thumb: dataUrl,
          fullsize: dataUrl,
          alt: 'Photo attachment',
        });
      }

      let embed = undefined;
      if (processedImages.length > 0) {
        embed = {
          $type: 'app.bsky.embed.images#view',
          images: processedImages,
        };
      } else if (video) {
        embed = {
          $type: 'app.bsky.embed.video#view',
          playlist: URL.createObjectURL(video),
          thumbnail: '',
        };
      } else if (quoted) {
        embed = {
          $type: 'app.bsky.embed.record#view',
          record: {
            uri: quoted.uri,
            cid: quoted.cid,
            author: quoted.author,
            value: {
              text: quoted.record?.text || '',
              createdAt: quoted.record?.createdAt || new Date().toISOString(),
            },
          },
        };
      }

      const newPostItem = {
        post: {
          uri: `at://${state.session.did}/app.bsky.feed.post/${Date.now()}`,
          cid: `bafy${Date.now()}`,
          author: {
            did: state.session.did,
            handle: state.session.handle,
            displayName: state.profile?.displayName || 'Alex Rivera',
            avatar: state.profile?.avatar || '/icon.svg',
          },
          record: {
            text: trimmedText,
            createdAt: new Date().toISOString(),
            quote: quoted
              ? {
                  uri: quoted.uri,
                  cid: quoted.cid,
                  author: quoted.author,
                  text: quoted.record?.text || '',
                  createdAt: quoted.record?.createdAt,
                }
              : undefined,
          },
          embed,
          replyCount: 0,
          repostCount: 0,
          likeCount: 0,
          viewer: {
            like: null,
            repost: null,
          },
        },
      };

      state.feed = [newPostItem, ...(state.feed || [])];
      if (state.profile) {
        state.profile.postsCount = (state.profile.postsCount || 0) + 1;
        renderUserProfileUI(state.profile);
      }
      saveSession(state.session, state.pdsEndpoint, true);

      clearComposerForms();
      closeModal('composer-modal');
      showToast(quoted ? 'Quote post published!' : 'Post published to Postr Social!', 'success');
      loadFeed(state.activeFeedTab);
      return;
    }

    if (!state.agent) throw new Error('Not logged in');
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

    // 3. Attach quote record if quoting
    if (quoted) {
      const quoteRecord = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: quoted.uri,
          cid: quoted.cid,
        },
      };

      if (embed && embed.$type === 'app.bsky.embed.images') {
        embed = {
          $type: 'app.bsky.embed.recordWithMedia',
          media: embed,
          record: quoteRecord,
        };
      } else if (!embed) {
        embed = quoteRecord;
      }
    }

    // 4. Post to timeline
    await state.agent.post({
      text: trimmedText,
      embed,
      createdAt: new Date().toISOString(),
    });

    // Reset fields
    clearComposerForms();
    closeModal('composer-modal');
    showToast(quoted ? 'Quote post published!' : 'Post published successfully!', 'success');

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

  clearQuotedPost();
  renderComposerAttachments('inline');
  renderComposerAttachments('modal');
  updateCharCounter();
}

// ==========================================
// Quote Post Management
// ==========================================

export function setQuotedPost(post) {
  state.activeQuotedPost = post;
  const author = post.author || {};
  const record = post.record || {};
  const text = record.text || '';

  // Update inline quote preview
  const inlineBox = document.getElementById('inline-quote-preview');
  const inlineAvatar = document.getElementById('inline-quote-avatar');
  const inlineAuthor = document.getElementById('inline-quote-author');
  const inlineHandle = document.getElementById('inline-quote-handle');
  const inlineText = document.getElementById('inline-quote-text');

  if (inlineBox) {
    if (inlineAvatar) inlineAvatar.src = author.avatar || '/icon.svg';
    if (inlineAuthor) inlineAuthor.textContent = author.displayName || author.handle || 'User';
    if (inlineHandle) inlineHandle.textContent = `@${author.handle || ''}`;
    if (inlineText) inlineText.textContent = text ? `"${text}"` : '';
    inlineBox.classList.remove('hidden');
  }

  // Update modal quote preview
  const modalBox = document.getElementById('modal-quote-preview');
  const modalAvatar = document.getElementById('modal-quote-avatar');
  const modalAuthor = document.getElementById('modal-quote-author');
  const modalHandle = document.getElementById('modal-quote-handle');
  const modalText = document.getElementById('modal-quote-text');

  if (modalBox) {
    if (modalAvatar) modalAvatar.src = author.avatar || '/icon.svg';
    if (modalAuthor) modalAuthor.textContent = author.displayName || author.handle || 'User';
    if (modalHandle) modalHandle.textContent = `@${author.handle || ''}`;
    if (modalText) modalText.textContent = text ? `"${text}"` : '';
    modalBox.classList.remove('hidden');
  }
}

export function clearQuotedPost() {
  state.activeQuotedPost = null;
  document.getElementById('inline-quote-preview')?.classList.add('hidden');
  document.getElementById('modal-quote-preview')?.classList.add('hidden');
}

export function openQuoteComposer(post) {
  setQuotedPost(post);
  openModal('composer-modal');
  setTimeout(() => {
    document.getElementById('modal-composer-textarea')?.focus();
  }, 100);
}

// ==========================================
// Repost & Quote Modal
// ==========================================

export function openRepostOptions(post) {
  state.activeRepostPost = post;
  const isReposted = Boolean(post.viewer?.repost);
  const labelEl = document.getElementById('label-action-repost');
  if (labelEl) {
    labelEl.textContent = isReposted ? 'Undo Repost' : 'Repost';
  }
  openModal('repost-options-modal');
}

// ==========================================
// Thread & Comments Modal
// ==========================================

export async function openPostThread(postUri) {
  if (!postUri) return;
  let post = state.feed?.find((i) => i.post.uri === postUri)?.post;

  if (!post && state.agent) {
    try {
      const res = await state.agent.getPostThread({ uri: postUri, depth: 6 });
      if (res.data.thread?.post) {
        post = res.data.thread.post;
      }
    } catch (err) {
      console.error('Error fetching thread post:', err);
    }
  }

  if (!post) {
    showToast('Post thread not found', 'error');
    return;
  }

  state.activeThreadPost = post;
  renderThreadParentPost(post);
  await loadThreadComments(post.uri);
  openModal('thread-modal');
}

export function renderThreadParentPost(post) {
  const container = document.getElementById('thread-parent-post');
  if (!container) return;

  const author = post.author || {};
  const record = post.record || {};
  const textContent = record.text || '';
  const createdAt = record.createdAt ? formatTimeAgo(record.createdAt) : '';

  const isLiked = Boolean(post.viewer?.like);
  const isReposted = Boolean(post.viewer?.repost);
  const likeCount = post.likeCount ?? 0;
  const repostCount = post.repostCount ?? 0;
  const replyCount = post.replyCount ?? 0;
  const isOwnPost =
    (state.session?.did && author.did === state.session.did) ||
    (state.isDemo && (author.did === state.session?.did || author.handle === state.session?.handle));

  const embedHtml = renderPostEmbed(post.embed, post.record);

  container.innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-2">
      <div class="flex items-center gap-2.5">
        <img src="${author.avatar || '/icon.svg'}" class="w-11 h-11 rounded-full object-cover border border-neutral-800" alt="" />
        <div>
          <h4 class="font-bold text-sm text-white">${escapeHtml(author.displayName || author.handle || 'Postr User')}</h4>
          <p class="text-xs text-neutral-400 font-mono">@${escapeHtml(author.handle || '')}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-neutral-400 font-mono">${createdAt}</span>
        ${
          isOwnPost
            ? `
          <button
            type="button"
            class="btn-post-delete p-1 rounded-lg text-neutral-500 hover:text-rose-400 hover:bg-neutral-900 transition"
            data-uri="${post.uri}"
            title="Delete Post"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        `
            : ''
        }
      </div>
    </div>
    <div class="text-sm sm:text-base text-neutral-100 whitespace-pre-wrap break-words leading-relaxed py-1">
      ${linkifyText(escapeHtml(textContent))}
    </div>
    ${embedHtml}
    <div class="mt-3 pt-2.5 border-t border-neutral-900 flex items-center justify-between text-neutral-400 text-xs max-w-sm">
      <div class="flex items-center gap-1.5 text-neutral-400">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
        <span class="thread-parent-reply-count">${replyCount} replies</span>
      </div>
      <button
        type="button"
        class="btn-post-repost flex items-center gap-1.5 ${isReposted ? 'text-green-400' : 'hover:text-green-400'} transition cursor-pointer"
        data-uri="${post.uri}"
        data-cid="${post.cid}"
        data-reposted="${isReposted}"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        <span class="repost-counter">${repostCount || ''}</span>
      </button>
      <button
        type="button"
        class="btn-post-like flex items-center gap-1.5 ${isLiked ? 'text-green-400' : 'hover:text-green-400'} transition cursor-pointer"
        data-uri="${post.uri}"
        data-cid="${post.cid}"
        data-liked="${isLiked}"
      >
        <svg class="w-4 h-4 ${isLiked ? 'fill-current' : 'fill-none'}" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
        <span class="like-counter">${likeCount || ''}</span>
      </button>
    </div>
  `;
}

export async function loadThreadComments(postUri) {
  const listContainer = document.getElementById('thread-comments-list');
  const headingEl = document.getElementById('thread-comments-heading');
  if (!listContainer) return;

  if (state.isDemo) {
    if (!state.commentsByPostUri) {
      state.commentsByPostUri = getInitialDemoComments();
    }
    const comments = state.commentsByPostUri[postUri] || [];
    if (headingEl) headingEl.textContent = `Comments (${comments.length})`;
    renderThreadComments(comments, postUri);
    return;
  }

  if (!state.agent) return;

  listContainer.innerHTML = `
    <div class="p-6 text-center text-neutral-500 text-xs flex flex-col items-center justify-center gap-2">
      <svg class="w-5 h-5 animate-spin text-green-500" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
      </svg>
      <span>Loading comments...</span>
    </div>
  `;

  try {
    const res = await state.agent.getPostThread({ uri: postUri, depth: 6 });
    const thread = res.data.thread;
    const replies = (thread?.replies || [])
      .map((r) => r.post)
      .filter(Boolean)
      .map((p) => ({
        id: p.uri,
        uri: p.uri,
        cid: p.cid,
        author: p.author,
        text: p.record?.text || '',
        createdAt: p.record?.createdAt || '',
        likeCount: p.likeCount || 0,
        viewer: p.viewer || {},
      }));

    if (headingEl) headingEl.textContent = `Comments (${replies.length})`;
    renderThreadComments(replies, postUri);
  } catch (err) {
    console.error('Error fetching thread comments:', err);
    listContainer.innerHTML = `
      <div class="p-6 text-center text-neutral-400 text-xs">
        Could not load comments: ${formatErrorMessage(err)}
      </div>
    `;
  }
}

export function renderThreadComments(comments, postUri) {
  const listContainer = document.getElementById('thread-comments-list');
  if (!listContainer) return;

  if (!comments || comments.length === 0) {
    listContainer.innerHTML = `
      <div class="p-8 text-center text-neutral-500 text-xs space-y-1">
        <p class="font-semibold text-neutral-400">No comments yet</p>
        <p class="text-[11px]">Be the first to share your thoughts on this post!</p>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = '';
  comments.forEach((c) => {
    const author = c.author || {};
    const createdAt = c.createdAt ? formatTimeAgo(c.createdAt) : '';
    const isLiked = Boolean(c.viewer?.like);
    const likeCount = c.likeCount ?? 0;
    const isOwnComment =
      (state.session?.did && author.did === state.session.did) ||
      (state.isDemo && (author.did === state.session?.did || author.handle === state.session?.handle));

    const itemEl = document.createElement('div');
    itemEl.className = 'p-3.5 hover:bg-neutral-950/60 transition flex gap-3 text-white';
    itemEl.dataset.commentId = c.id;
    itemEl.dataset.postUri = postUri;

    itemEl.innerHTML = `
      <img src="${author.avatar || '/icon.svg'}" class="w-8 h-8 rounded-full object-cover border border-neutral-800 shrink-0" alt="" />
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 truncate">
            <span class="font-bold text-xs text-white truncate">${escapeHtml(author.displayName || author.handle || 'User')}</span>
            <span class="text-[11px] font-mono text-neutral-400 truncate">@${escapeHtml(author.handle || '')}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <time class="text-[10px] text-neutral-500 font-mono">${createdAt}</time>
            ${
              isOwnComment
                ? `
              <button
                type="button"
                class="btn-delete-comment p-1 rounded-md text-neutral-500 hover:text-rose-400 hover:bg-neutral-900 transition cursor-pointer"
                title="Delete Comment"
                data-comment-id="${c.id}"
                data-post-uri="${postUri}"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            `
                : ''
            }
          </div>
        </div>
        <p class="mt-1 text-xs sm:text-sm text-neutral-200 leading-relaxed break-words whitespace-pre-wrap">${linkifyText(escapeHtml(c.text))}</p>
        <div class="mt-2 flex items-center gap-3">
          <button
            type="button"
            class="btn-comment-like flex items-center gap-1 text-[11px] ${isLiked ? 'text-green-400' : 'text-neutral-500 hover:text-green-400'} transition cursor-pointer"
            data-comment-id="${c.id}"
            data-post-uri="${postUri}"
            data-liked="${isLiked}"
          >
            <svg class="w-3.5 h-3.5 ${isLiked ? 'fill-current' : 'fill-none'}" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
            </svg>
            <span class="comment-like-count">${likeCount > 0 ? likeCount : ''}</span>
          </button>
        </div>
      </div>
    `;

    listContainer.appendChild(itemEl);
  });
}

export async function submitThreadComment(postUri, text) {
  const trimmed = text.trim();
  if (!trimmed) {
    showToast('Please enter a comment before replying', 'info');
    return;
  }

  const submitBtn = document.getElementById('btn-thread-submit-reply');
  const spinner = submitBtn?.querySelector('.btn-spinner');
  if (submitBtn) submitBtn.disabled = true;
  if (spinner) spinner.classList.remove('hidden');

  try {
    if (state.isDemo) {
      if (!state.commentsByPostUri) {
        state.commentsByPostUri = getInitialDemoComments();
      }
      if (!state.commentsByPostUri[postUri]) {
        state.commentsByPostUri[postUri] = [];
      }

      const newComment = {
        id: 'comm_' + Date.now(),
        uri: `at://${state.session.did}/app.bsky.feed.post/${Date.now()}`,
        author: {
          did: state.session.did,
          handle: state.session.handle,
          displayName: state.profile?.displayName || 'Alex Rivera',
          avatar: state.profile?.avatar || '/icon.svg',
        },
        text: trimmed,
        createdAt: new Date().toISOString(),
        likeCount: 0,
        viewer: { like: null },
      };

      state.commentsByPostUri[postUri].push(newComment);

      // Increment reply count on the post
      const targetPost = state.feed?.find((i) => i.post.uri === postUri)?.post;
      if (targetPost) {
        targetPost.replyCount = (targetPost.replyCount || 0) + 1;
      }
      if (state.activeThreadPost && state.activeThreadPost.uri === postUri) {
        state.activeThreadPost.replyCount = (state.activeThreadPost.replyCount || 0) + 1;
        const repCountEl = document.querySelector('.thread-parent-reply-count');
        if (repCountEl) repCountEl.textContent = `${state.activeThreadPost.replyCount} replies`;
      }

      // Update reply counters in feed cards
      updatePostReplyCountInDOM(postUri, targetPost?.replyCount || 1);
      saveSession(state.session, state.pdsEndpoint, true);

      // Clear input
      const input = document.getElementById('thread-reply-input');
      if (input) input.value = '';

      // Re-render comments
      renderThreadComments(state.commentsByPostUri[postUri], postUri);
      const headingEl = document.getElementById('thread-comments-heading');
      if (headingEl) headingEl.textContent = `Comments (${state.commentsByPostUri[postUri].length})`;

      showToast('Comment posted successfully!', 'success');
      return;
    }

    if (!state.agent) return;

    const parentPost = state.activeThreadPost;
    const parentRef = { uri: parentPost.uri, cid: parentPost.cid };

    await state.agent.post({
      text: trimmed,
      reply: {
        root: parentRef,
        parent: parentRef,
      },
      createdAt: new Date().toISOString(),
    });

    const input = document.getElementById('thread-reply-input');
    if (input) input.value = '';

    showToast('Reply posted successfully!', 'success');
    await loadThreadComments(postUri);
    loadFeed(state.activeFeedTab);
  } catch (err) {
    console.error('Error submitting reply:', err);
    showToast('Failed to post reply: ' + formatErrorMessage(err), 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (spinner) spinner.classList.add('hidden');
  }
}

export function toggleLikeComment(button) {
  const commentId = button.dataset.commentId;
  const postUri = button.dataset.postUri;
  const isLiked = button.dataset.liked === 'true';

  const countEl = button.querySelector('.comment-like-count');
  let currentCount = parseInt(countEl?.textContent || '0', 10);

  button.dataset.liked = (!isLiked).toString();
  const svg = button.querySelector('svg');

  if (isLiked) {
    svg?.classList.remove('fill-current');
    button.classList.remove('text-green-400');
    button.classList.add('text-neutral-500');
    if (countEl) countEl.textContent = Math.max(0, currentCount - 1) || '';
  } else {
    svg?.classList.add('fill-current');
    button.classList.add('text-green-400');
    button.classList.remove('text-neutral-500');
    if (countEl) countEl.textContent = (currentCount + 1).toString();
  }

  if (state.isDemo) {
    const comments = state.commentsByPostUri?.[postUri];
    const target = comments?.find((c) => c.id === commentId);
    if (target) {
      if (isLiked) {
        target.viewer = { like: null };
        target.likeCount = Math.max(0, (target.likeCount || 0) - 1);
      } else {
        target.viewer = { like: `at://${state.session.did}/like/${Date.now()}` };
        target.likeCount = (target.likeCount || 0) + 1;
      }
      saveSession(state.session, state.pdsEndpoint, true);
    }
  }
}

function updatePostReplyCountInDOM(postUri, count) {
  document.querySelectorAll(`article[data-uri="${postUri}"]`).forEach((card) => {
    const replyCountEl = card.querySelector('.btn-post-reply span');
    if (replyCountEl) replyCountEl.textContent = count > 0 ? count : '';
  });
}

// ==========================================
// Deletion Management: Posts & Comments
// ==========================================

export function promptDeletePost(postUri) {
  state.deleteTarget = { type: 'post', uri: postUri };
  const titleEl = document.getElementById('delete-modal-title');
  const descEl = document.getElementById('delete-modal-desc');

  if (titleEl) titleEl.textContent = 'Delete Post?';
  if (descEl) descEl.textContent = 'Are you sure you want to delete this post? This action cannot be undone.';

  openModal('delete-confirm-modal');
}

export function promptDeleteComment(postUri, commentId) {
  state.deleteTarget = { type: 'comment', postUri, commentId };
  const titleEl = document.getElementById('delete-modal-title');
  const descEl = document.getElementById('delete-modal-desc');

  if (titleEl) titleEl.textContent = 'Delete Comment?';
  if (descEl) descEl.textContent = 'Are you sure you want to delete this comment? This action cannot be undone.';

  openModal('delete-confirm-modal');
}

export async function executeDeleteTarget() {
  if (!state.deleteTarget) return;
  const { type, uri, postUri, commentId } = state.deleteTarget;

  const confirmBtn = document.getElementById('btn-confirm-delete');
  const spinner = document.getElementById('delete-spinner');
  if (confirmBtn) confirmBtn.disabled = true;
  if (spinner) spinner.classList.remove('hidden');

  try {
    if (type === 'post') {
      if (state.isDemo) {
        state.feed = (state.feed || []).filter((i) => i.post.uri !== uri);
        if (state.commentsByPostUri?.[uri]) {
          delete state.commentsByPostUri[uri];
        }
        if (state.profile) {
          state.profile.postsCount = Math.max(0, (state.profile.postsCount || 0) - 1);
          renderUserProfileUI(state.profile);
        }
        saveSession(state.session, state.pdsEndpoint, true);

        // If thread modal was showing this post, close it
        if (state.activeThreadPost && state.activeThreadPost.uri === uri) {
          closeModal('thread-modal');
        }

        closeModal('delete-confirm-modal');
        loadFeed(state.activeFeedTab);
        showToast('Post deleted successfully', 'success');
        return;
      }

      if (state.agent) {
        await state.agent.deletePost(uri);
        state.feed = (state.feed || []).filter((i) => i.post.uri !== uri);
        if (state.activeThreadPost && state.activeThreadPost.uri === uri) {
          closeModal('thread-modal');
        }
        closeModal('delete-confirm-modal');
        loadFeed(state.activeFeedTab);
        showToast('Post deleted successfully', 'success');
        return;
      }
    }

    if (type === 'comment') {
      if (state.isDemo) {
        if (state.commentsByPostUri?.[postUri]) {
          state.commentsByPostUri[postUri] = state.commentsByPostUri[postUri].filter((c) => c.id !== commentId);

          const targetPost = state.feed?.find((i) => i.post.uri === postUri)?.post;
          if (targetPost) {
            targetPost.replyCount = Math.max(0, (targetPost.replyCount || 0) - 1);
          }
          if (state.activeThreadPost && state.activeThreadPost.uri === postUri) {
            state.activeThreadPost.replyCount = Math.max(0, (state.activeThreadPost.replyCount || 0) - 1);
            const repCountEl = document.querySelector('.thread-parent-reply-count');
            if (repCountEl) repCountEl.textContent = `${state.activeThreadPost.replyCount} replies`;
          }

          updatePostReplyCountInDOM(postUri, targetPost?.replyCount || 0);
          saveSession(state.session, state.pdsEndpoint, true);

          renderThreadComments(state.commentsByPostUri[postUri], postUri);
          const headingEl = document.getElementById('thread-comments-heading');
          if (headingEl) headingEl.textContent = `Comments (${state.commentsByPostUri[postUri].length})`;
        }

        closeModal('delete-confirm-modal');
        showToast('Comment deleted', 'success');
        return;
      }

      if (state.agent) {
        await state.agent.deletePost(commentId);
        closeModal('delete-confirm-modal');
        showToast('Comment deleted', 'success');
        await loadThreadComments(postUri);
        loadFeed(state.activeFeedTab);
        return;
      }
    }
  } catch (err) {
    console.error('Error executing delete:', err);
    showToast('Failed to delete: ' + formatErrorMessage(err), 'error');
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    if (spinner) spinner.classList.add('hidden');
    state.deleteTarget = null;
  }
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

  if (state.isDemo) {
    const q = trimmed.toLowerCase();
    const matches = DEMO_ACTORS.filter(
      (a) => a.handle.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q)
    );
    if (matches.length === 0) {
      container.innerHTML = `
        <div class="py-12 text-center text-neutral-400 text-xs">
          No accounts found matching "${escapeHtml(trimmed)}".
        </div>
      `;
      return;
    }
    container.innerHTML = '';
    matches.forEach((actor) => {
      const card = createActorCardElement(actor);
      container.appendChild(card);
    });
    return;
  }

  if (!state.agent) return;

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
  const did = button.dataset.did;
  const isFollowing = button.dataset.following === 'true';
  const followUri = button.dataset.followUri;

  button.disabled = true;

  if (state.isDemo) {
    if (isFollowing) {
      state.followingMap.delete(did);
      button.dataset.following = 'false';
      button.dataset.followUri = '';
      button.textContent = 'Follow';
      button.className = 'btn-follow-toggle px-3.5 py-1.5 rounded-xl text-xs font-bold transition shrink-0 bg-green-500 hover:bg-green-400 text-black shadow-md shadow-green-950/40 cursor-pointer';
      showToast('Unfollowed account', 'info');
      if (state.profile) {
        state.profile.followsCount = Math.max(0, (state.profile.followsCount || 0) - 1);
        renderUserProfileUI(state.profile);
      }
    } else {
      state.followingMap.set(did, `at://${state.session.did}/follow/${did}`);
      button.dataset.following = 'true';
      button.dataset.followUri = `at://${state.session.did}/follow/${did}`;
      button.textContent = 'Following';
      button.className = 'btn-follow-toggle px-3.5 py-1.5 rounded-xl text-xs font-bold transition shrink-0 bg-neutral-900 hover:bg-neutral-800 text-white border border-neutral-700 hover:border-rose-500/50 hover:text-rose-400 cursor-pointer';
      showToast('Following account!', 'success');
      if (state.profile) {
        state.profile.followsCount = (state.profile.followsCount || 0) + 1;
        renderUserProfileUI(state.profile);
      }
    }
    button.disabled = false;
    return;
  }

  if (!state.agent) {
    button.disabled = false;
    return;
  }

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

  if (state.isDemo) {
    const postItem = state.feed?.find((i) => i.post.uri === uri);
    if (postItem) {
      if (isLiked) {
        postItem.post.viewer.like = null;
        postItem.post.likeCount = Math.max(0, (postItem.post.likeCount || 0) - 1);
      } else {
        postItem.post.viewer.like = `at://${state.session.did}/like/${Date.now()}`;
        postItem.post.likeCount = (postItem.post.likeCount || 0) + 1;
      }
    }
    saveSession(state.session, state.pdsEndpoint, true);
    return;
  }

  if (!state.agent) return;

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

  if (state.isDemo) {
    const postItem = state.feed?.find((i) => i.post.uri === uri);
    if (postItem) {
      if (isReposted) {
        postItem.post.viewer.repost = null;
        postItem.post.repostCount = Math.max(0, (postItem.post.repostCount || 0) - 1);
      } else {
        postItem.post.viewer.repost = `at://${state.session.did}/repost/${Date.now()}`;
        postItem.post.repostCount = (postItem.post.repostCount || 0) + 1;
        showToast('Reposted to your followers', 'success');
      }
    }
    saveSession(state.session, state.pdsEndpoint, true);
    return;
  }

  if (!state.agent) return;

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

  // 3b. Instant Demo Preview Button
  document.getElementById('btn-demo-login')?.addEventListener('click', async (e) => {
    e.preventDefault();
    clearAuthError();
    await enterDemoMode();
  });

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

  // 17. Modals for Threads, Repost Options, Delete Confirmation & Quotes
  document.getElementById('btn-close-thread')?.addEventListener('click', () => closeModal('thread-modal'));

  document.getElementById('form-thread-reply')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.activeThreadPost) return;
    const input = document.getElementById('thread-reply-input');
    submitThreadComment(state.activeThreadPost.uri, input?.value || '');
  });

  // Repost & Quote Modal triggers
  document.getElementById('btn-close-repost-options')?.addEventListener('click', () => closeModal('repost-options-modal'));
  document.getElementById('btn-cancel-repost-options')?.addEventListener('click', () => closeModal('repost-options-modal'));

  document.getElementById('btn-action-repost')?.addEventListener('click', () => {
    closeModal('repost-options-modal');
    if (!state.activeRepostPost) return;
    const targetCardBtn = document.querySelector(`article[data-uri="${state.activeRepostPost.uri}"] .btn-post-repost`);
    if (targetCardBtn) {
      toggleRepostPost(targetCardBtn);
    } else {
      const dummyBtn = document.createElement('button');
      dummyBtn.dataset.uri = state.activeRepostPost.uri;
      dummyBtn.dataset.cid = state.activeRepostPost.cid;
      dummyBtn.dataset.reposted = Boolean(state.activeRepostPost.viewer?.repost).toString();
      dummyBtn.dataset.repostUri = state.activeRepostPost.viewer?.repost || '';
      toggleRepostPost(dummyBtn);
    }
  });

  document.getElementById('btn-action-quote')?.addEventListener('click', () => {
    closeModal('repost-options-modal');
    if (!state.activeRepostPost) return;
    openQuoteComposer(state.activeRepostPost);
  });

  // Delete Confirm Modal triggers
  document.getElementById('btn-close-delete-modal')?.addEventListener('click', () => closeModal('delete-confirm-modal'));
  document.getElementById('btn-cancel-delete')?.addEventListener('click', () => closeModal('delete-confirm-modal'));
  document.getElementById('btn-confirm-delete')?.addEventListener('click', executeDeleteTarget);

  // Clear quote preview in composers
  document.getElementById('btn-inline-remove-quote')?.addEventListener('click', clearQuotedPost);
  document.getElementById('btn-modal-remove-quote')?.addEventListener('click', clearQuotedPost);

  // 18. Like, Repost, Reply, Delete & Share Delegates on Posts
  document.addEventListener('click', (e) => {
    // Reply / Comment Button
    const replyBtn = e.target.closest('.btn-post-reply');
    if (replyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const postUri = replyBtn.dataset.uri || replyBtn.closest('article')?.dataset.uri;
      openPostThread(postUri);
      return;
    }

    // Repost / Quote Button
    const repostBtn = e.target.closest('.btn-post-repost');
    if (repostBtn) {
      e.preventDefault();
      e.stopPropagation();
      const postUri = repostBtn.dataset.uri;
      const post =
        state.feed?.find((i) => i.post.uri === postUri)?.post ||
        (state.activeThreadPost?.uri === postUri ? state.activeThreadPost : null);
      if (post) {
        openRepostOptions(post);
      } else {
        toggleRepostPost(repostBtn);
      }
      return;
    }

    // Like Post Button
    const likeBtn = e.target.closest('.btn-post-like');
    if (likeBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleLikePost(likeBtn);
      return;
    }

    // Delete Post Button
    const deletePostBtn = e.target.closest('.btn-post-delete');
    if (deletePostBtn) {
      e.preventDefault();
      e.stopPropagation();
      const postUri = deletePostBtn.dataset.uri;
      promptDeletePost(postUri);
      return;
    }

    // Delete Comment Button
    const deleteCommentBtn = e.target.closest('.btn-delete-comment');
    if (deleteCommentBtn) {
      e.preventDefault();
      e.stopPropagation();
      const commentId = deleteCommentBtn.dataset.commentId;
      const postUri = deleteCommentBtn.dataset.postUri;
      promptDeleteComment(postUri, commentId);
      return;
    }

    // Like Comment Button
    const commentLikeBtn = e.target.closest('.btn-comment-like');
    if (commentLikeBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleLikeComment(commentLikeBtn);
      return;
    }

    // Quoted Post Card inside a post -> click opens thread for quoted post
    const quotedCard = e.target.closest('.quoted-post-card');
    if (quotedCard) {
      e.preventDefault();
      e.stopPropagation();
      const uri = quotedCard.dataset.uri;
      if (uri) openPostThread(uri);
      return;
    }

    // Share Post Link
    const shareBtn = e.target.closest('.btn-post-share');
    if (shareBtn) {
      e.preventDefault();
      e.stopPropagation();
      const author = shareBtn.dataset.author;
      const rkey = shareBtn.dataset.rkey;
      const postUrl = `https://postersocial.app/profile/${author}/post/${rkey}`;

      if (navigator.share) {
        navigator
          .share({
            title: `Post on Postr Social (@${author})`,
            text: `Check out this post on Postr Social:`,
            url: postUrl,
          })
          .catch(() => {});
      } else {
        navigator.clipboard
          .writeText(postUrl)
          .then(() => {
            showToast('Post link copied to clipboard!', 'success');
          })
          .catch(() => {
            showToast('Could not copy link', 'error');
          });
      }
      return;
    }

    // Clicking anywhere on a post card opens the thread (unless clicking links, buttons, etc.)
    const postCard = e.target.closest('article[data-uri]');
    if (postCard && !e.target.closest('button, a, video, input, textarea, label')) {
      const postUri = postCard.dataset.uri;
      if (postUri) {
        openPostThread(postUri);
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
