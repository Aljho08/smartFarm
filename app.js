// Smart-Farm Application & Supabase Control Script
const API_BASE = 'http://localhost:5001/api';
const DEFAULT_AVATAR_URL = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=256';
const RECOVERY_QUESTIONS = [
  { id: 'first_school', label: 'What was the name of your first school?' },
  { id: 'birth_city', label: 'In what city were you born?' },
  { id: 'first_pet', label: 'What was the name of your first pet?' },
  { id: 'childhood_friend', label: 'What was the first name of your childhood best friend?' }
];
const SENSOR_STALE_AFTER_MS = 30_000;
const HISTORY_REFRESH_INTERVAL_MS = 30_000;
let lastHistoryFetchAt = 0;

function isPasswordRecoveryCallbackUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return query.get('recovery') === '1' || query.get('type') === 'recovery' || hash.get('type') === 'recovery';
}

function activatePasswordRecoveryScreen() {
  state.isPasswordRecovery = true;
  showAuthOverlay();
  document.querySelectorAll('.custom-login-card').forEach(card => card.classList.remove('active'));
  document.getElementById('resetPasswordCard')?.classList.add('active');
}

let supabaseClient = null;
async function initializeSupabaseClient() {
  if (!window.supabase) throw new Error('Supabase client library is unavailable.');
  const response = await fetch(`${API_BASE}/config`);
  const config = await response.json();
  if (!response.ok || !config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('Supabase browser configuration is missing.');
  }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    supabaseClient.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') activatePasswordRecoveryScreen();
      if (event === 'SIGNED_OUT') clearSignInCredentials();
    });
}

// Global Application State
const state = {
  activeView: 'dashboard',
  currentUser: null,
  isPasswordRecovery: isPasswordRecoveryCallbackUrl(),
  telemetry: {
    temperature: null,
    humidity: null,
    soilMoistureA: null,
    soilMoistureB: null,
    pumpState: null,
    timestamp: null
  },
  trendReadings: [],
  charts: { trend: null, reportSoil: null, reportTemp: null, reportHum: null },
  monthlyReport: null,
  availableReportMonths: [],
  isOnline: false
};

const CROPS_DATA = [
  {
    name: 'Lettuce',
    imageUrl: '/smartfarm-backend/crop-image/lettuce.jpg',
    season: 'Cool season',
    tempRange: [15, 22],
    idealHumidity: '55%–70%',
    description: 'A cool-season leafy crop that grows best in mild temperatures. Keep the soil consistently moist and provide shade during unusually warm days.'
  },
  {
    name: 'Cabbage',
    imageUrl: '/smartfarm-backend/crop-image/cabbage.jpg',
    season: 'Cool season',
    tempRange: [12, 20],
    idealHumidity: '60%–80%',
    description: 'A hardy cool-season crop that develops best in mild weather. Use fertile, well-drained soil and steady watering for firm heads.'
  },
  {
    name: 'Monggo (Mung Bean)',
    imageUrl: '/smartfarm-backend/crop-image/monngo.jpg',
    season: 'Warm season',
    tempRange: [25, 30],
    idealHumidity: '40%–70%',
    description: 'Monggo grows quickly in warm weather. Provide good sunlight, well-drained soil, and avoid keeping the roots waterlogged.'
  },
  {
    name: 'Tomato',
    imageUrl: '/smartfarm-backend/crop-image/tomato.jpg',
    season: 'Mild to warm season',
    tempRange: [20, 28],
    idealHumidity: '60%–70%',
    description: 'Tomatoes prefer warm days and well-draining soil. Regular watering helps prevent fruit splitting and blossom-end problems.'
  },
  {
    name: 'Chili',
    imageUrl: '/smartfarm-backend/crop-image/chilli.jpg',
    season: 'Warm season',
    tempRange: [22, 32],
    idealHumidity: '50%–70%',
    description: 'Chili plants thrive in warm conditions with good sunlight. Water consistently while allowing excess water to drain freely.'
  }
];

// Application Lifecycle Entrypoint
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initializeSupabaseClient();
  } catch (error) {
    console.error('Supabase initialization failed:', error.message);
  }

  initClock();
  initNavigation();
  initAuthUI();
  initSettingsUI();
  initNotifications();
  initIrrigationControls();
  initTrendChart();
  initReportCharts();
  initReportControls();

  await restoreUserSession();

  // Initial Telemetry Fetch & Realtime Listeners
  await fetchLatestTelemetry();

  // Live polling for ESP32 telemetry every 2.5s
  setInterval(fetchLatestTelemetry, 2500);
});

// ==================== AUTHENTICATION & SESSION LOGIC ==================== //
function configureSecurityQuestionPicker(pickerId, valueInputId, questions, placeholder) {
  const picker = document.getElementById(pickerId);
  const valueInput = document.getElementById(valueInputId);
  const toggle = picker.querySelector('.security-question-toggle');
  const toggleLabel = toggle.querySelector('span');
  const optionsPanel = picker.querySelector('.security-question-options');

  function closeOptions() {
    optionsPanel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function setOptions(availableQuestions) {
    optionsPanel.replaceChildren();
    valueInput.value = '';
    toggleLabel.textContent = placeholder;

    availableQuestions.forEach(question => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'security-question-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.dataset.questionId = question.id;
      option.textContent = question.label;
      option.addEventListener('click', () => {
        valueInput.value = question.id;
        toggleLabel.textContent = question.label;
        optionsPanel.querySelectorAll('[role="option"]').forEach(item => {
          item.setAttribute('aria-selected', String(item === option));
        });
        closeOptions();
        valueInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      optionsPanel.appendChild(option);
    });

    if (availableQuestions.length === 1) {
      valueInput.value = availableQuestions[0].id;
      toggleLabel.textContent = availableQuestions[0].label;
      optionsPanel.querySelector('[role="option"]')?.setAttribute('aria-selected', 'true');
    }
    closeOptions();
  }

  function toggleOptions() {
    optionsPanel.hidden = !optionsPanel.hidden;
    toggle.setAttribute('aria-expanded', String(!optionsPanel.hidden));
  }

  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeOptions();
  });
  document.addEventListener('click', event => {
    if (!picker.contains(event.target)) closeOptions();
  });

  setOptions(questions);
  return { toggle, setOptions, toggleOptions };
}

function initAuthUI() {
  const loginForm = document.getElementById('customLoginForm');
  const signUpForm = document.getElementById('customSignUpForm');
  const forgotPasswordForm = document.getElementById('forgotPasswordForm');
  const resetPasswordForm = document.getElementById('resetPasswordForm');
  const linkToSignUp = document.getElementById('linkToSignUp');
  const linkToLogin = document.getElementById('linkToLogin');
  const linkToForgotPassword = document.getElementById('linkToForgotPassword');
  const linkBackToLogin = document.getElementById('linkBackToLogin');
  const loginCard = document.getElementById('loginCard');
  const signUpCard = document.getElementById('signUpCard');
  const forgotPasswordCard = document.getElementById('forgotPasswordCard');
  const resetPasswordCard = document.getElementById('resetPasswordCard');
  const signUpQuestionPicker = configureSecurityQuestionPicker(
    'signUpSecurityQuestionPicker',
    'signUpSecurityQuestion',
    RECOVERY_QUESTIONS,
    'Select a security question'
  );
  const recoveryQuestionPicker = configureSecurityQuestionPicker(
    'recoverySecurityQuestionPicker',
    'recoverySecurityQuestion',
    [],
    'Your saved security question'
  );

  function activateAuthCard(card) {
    document.querySelectorAll('.custom-login-card').forEach(item => item.classList.remove('active'));
    card?.classList.add('active');
    hideAuthMessage();
  }

  // Toggle View: Login -> Sign Up
  if (linkToSignUp) {
    linkToSignUp.addEventListener('click', (e) => {
      e.preventDefault();
      activateAuthCard(signUpCard);
    });
  }

  // Toggle View: Sign Up -> Login
  if (linkToLogin) {
    linkToLogin.addEventListener('click', (e) => {
      e.preventDefault();
      activateAuthCard(loginCard);
    });
  }

  linkToForgotPassword?.addEventListener('click', event => {
    event.preventDefault();
    forgotPasswordForm.reset();
    document.getElementById('recoveryDetails').hidden = true;
    document.getElementById('recoveryQuestionRow').hidden = false;
    document.getElementById('recoveryAnswerRow').hidden = false;
    document.getElementById('recoverySecurityAnswer').required = false;
    recoveryQuestionPicker.setOptions([]);
    document.getElementById('recoveryEmail').value = document.getElementById('signInUsername').value.trim();
    forgotPasswordForm.dataset.lookupComplete = 'false';
    activateAuthCard(forgotPasswordCard);
  });

  linkBackToLogin?.addEventListener('click', event => {
    event.preventDefault();
    activateAuthCard(loginCard);
  });

  if (state.isPasswordRecovery) {
    showAuthOverlay();
    activateAuthCard(resetPasswordCard);
  }

  signUpQuestionPicker.toggle.addEventListener('click', () => signUpQuestionPicker.toggleOptions());
  recoveryQuestionPicker.toggle.addEventListener('click', () => recoveryQuestionPicker.toggleOptions());

  // LOGIN FORM SUBMISSION
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const emailInput = document.getElementById('signInUsername').value.trim();
      const password = document.getElementById('signInPassword').value;

      showAuthMessage('Authenticating...', 'success');

      try {
        if (!supabaseClient) throw new Error('Supabase client is not initialized.');

        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email: emailInput,
          password: password
        });

        if (error) throw error;
        const user = data.user;
        const profileResponse = await authorizedApiFetch('/profile');
        const profile = await profileResponse.json();
        if (!profileResponse.ok) {
          await supabaseClient.auth.signOut();
          throw new Error(profile.error || 'Your account profile could not be verified. Contact farm administration.');
        }

        if (!profile.is_approved) {
          await supabaseClient.auth.signOut();
          localStorage.removeItem('smartfarm_user');
          throw new Error('Your account is awaiting approval by a farm owner or administrator.');
        }

        const userSession = {
          id: user.id,
          email: user.email,
          name: profile.full_name || user.email.split('@')[0],
          role: (profile.role || 'farmer').replace(/_/g, ' ').toUpperCase(),
          roleKey: profile.role || 'farmer',
          avatarUrl: profile.avatar_url || '',
          recoveryQuestionId: profile.recovery_question_id || ''
        };

        applyLoggedInUser(userSession);
        await loadAvailableReportMonths();
        hideAuthOverlay();
        showToast(`Welcome back, ${userSession.name}!`);

      } catch (err) {
        console.error('Login Error:', err.message);
        showAuthMessage(err.message || 'Invalid login credentials.', 'error');
      }
    });
  }

  // SIGN UP FORM SUBMISSION
  if (signUpForm) {
    signUpForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const fullName = document.getElementById('signUpFullName').value.trim();
      const email = document.getElementById('signUpEmail').value.trim();
      const password = document.getElementById('signUpPassword').value;
      const securityQuestion = document.getElementById('signUpSecurityQuestion').value;
      const securityAnswer = document.getElementById('signUpSecurityAnswer').value.trim();

      if (!securityQuestion) {
        showAuthMessage('Select a security question.', 'error');
        return;
      }

      showAuthMessage('Submitting account for approval...', 'success');

      try {
        if (!supabaseClient) throw new Error('Supabase client is not initialized.');

        // Register in auth.users and pass metadata for public.profiles trigger
        const { data, error } = await supabaseClient.auth.signUp({
          email: email,
          password: password,
          options: {
            data: {
              full_name: fullName,
              role: 'farmer',
              security_question: securityQuestion,
              security_answer: securityAnswer
            }
          }
        });

        if (error) throw error;

        if (data.user) {
          if (data.session) await supabaseClient.auth.signOut();
          signUpForm.reset();
          signUpQuestionPicker.setOptions(RECOVERY_QUESTIONS);
          signUpCard.classList.remove('active');
          loginCard.classList.add('active');
          showAuthMessage('Account submitted. You can sign in after a farm owner or administrator approves it.', 'success');
        }
      } catch (err) {
        console.error('Sign Up Error:', err.message);
        showAuthMessage(err.message || 'Failed to register user.', 'error');
      }
    });
  }

  document.getElementById('recoveryEmail')?.addEventListener('input', () => {
    forgotPasswordForm.dataset.lookupComplete = 'false';
    document.getElementById('recoveryDetails').hidden = true;
    recoveryQuestionPicker.setOptions([]);
  });

  document.getElementById('lookupRecoveryQuestionButton')?.addEventListener('click', async () => {
    const emailInput = document.getElementById('recoveryEmail');
    if (!emailInput.reportValidity()) return;

    const lookupButton = document.getElementById('lookupRecoveryQuestionButton');
    lookupButton.disabled = true;
    try {
      const response = await fetch(`${API_BASE}/auth/recovery/question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value.trim() })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load recovery information.');

      const hasQuestion = RECOVERY_QUESTIONS.some(question => question.id === result.questionId);
      const questionRow = document.getElementById('recoveryQuestionRow');
      const answerRow = document.getElementById('recoveryAnswerRow');
      const answerInput = document.getElementById('recoverySecurityAnswer');
      const hint = document.getElementById('recoveryHint');

      recoveryQuestionPicker.setOptions(hasQuestion
        ? RECOVERY_QUESTIONS.filter(question => question.id === result.questionId)
        : []);
      questionRow.hidden = !hasQuestion;
      answerRow.hidden = !hasQuestion;
      answerInput.required = hasQuestion;
      hint.textContent = hasQuestion
        ? 'Answer your saved security question to continue.'
        : 'No security answer is enrolled. You can continue with email recovery.';
      document.getElementById('recoveryDetails').hidden = false;
      forgotPasswordForm.dataset.lookupComplete = 'true';
    } catch (error) {
      showAuthMessage(error.message, 'error');
    } finally {
      lookupButton.disabled = false;
    }
  });

  forgotPasswordForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (forgotPasswordForm.dataset.lookupComplete !== 'true') {
      showAuthMessage('Enter your email and select Continue first.', 'error');
      return;
    }
    const email = document.getElementById('recoveryEmail').value.trim();
    const questionId = document.getElementById('recoverySecurityQuestion').value;
    const answer = document.getElementById('recoverySecurityAnswer').value.trim();
    const genericMessage = 'If the information matches an account, a password recovery email will be sent.';

    try {
      const response = await fetch(`${API_BASE}/auth/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, questionId, answer })
      });
      if (!response.ok) throw new Error('Recovery service is temporarily unavailable. Try again later.');

      forgotPasswordForm.reset();
      activateAuthCard(loginCard);
      showAuthMessage(genericMessage, 'success');
    } catch (error) {
      showAuthMessage(error.message, 'error');
    }
  });

  resetPasswordForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('newPassword').value;
    const confirmation = document.getElementById('confirmNewPassword').value;
    if (password !== confirmation) {
      showAuthMessage('The passwords do not match.', 'error');
      return;
    }

    try {
      const { error } = await supabaseClient.auth.updateUser({ password });
      if (error) throw error;
      await supabaseClient.auth.signOut();
      state.isPasswordRecovery = false;
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('recovery');
      cleanUrl.searchParams.delete('code');
      cleanUrl.searchParams.delete('type');
      cleanUrl.hash = '';
      window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}`);
      resetPasswordForm.reset();
      activateAuthCard(loginCard);
      showAuthMessage('Password updated. Sign in with your new password.', 'success');
    } catch (error) {
      showAuthMessage(error.message || 'Could not update your password.', 'error');
    }
  });

  // Logout Handlers
  document.getElementById('dropdownLogoutBtn')?.addEventListener('click', logoutUser);
  document.getElementById('sidebarSignOutBtn')?.addEventListener('click', logoutUser);
  document.getElementById('settingsBtnLogout')?.addEventListener('click', logoutUser);
}

function applyLoggedInUser(user) {
  state.currentUser = user;
  localStorage.setItem('smartfarm_user', JSON.stringify(user));

  const nameEl = document.getElementById('headerUserName');
  const dropNameEl = document.getElementById('dropdownUserName');
  const dropEmailEl = document.getElementById('dropdownUserEmail');
  const dropRoleEl = document.getElementById('dropdownUserRole');
  const avatarEl = document.getElementById('headerAvatarImg');

  if (nameEl) nameEl.innerText = user.name;
  if (dropNameEl) dropNameEl.innerText = user.name;
  if (dropEmailEl) dropEmailEl.innerText = user.email;
  if (dropRoleEl) dropRoleEl.innerText = user.role;
  if (avatarEl) avatarEl.src = user.avatarUrl || DEFAULT_AVATAR_URL;
  updateSettingsAccess();
}

async function authorizedApiFetch(path, options = {}) {
  if (!supabaseClient) throw new Error('Supabase client is not initialized.');
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Please sign in again.');

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${session.access_token}`
    }
  });
}

async function restoreUserSession() {
  if (state.isPasswordRecovery) {
    showAuthOverlay();
    return;
  }

  const savedUser = localStorage.getItem('smartfarm_user');
  if (!savedUser || !supabaseClient) {
    localStorage.removeItem('smartfarm_user');
    showAuthOverlay();
    return;
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) throw new Error('No active session.');

    const profileResponse = await authorizedApiFetch('/profile');
    const profile = await profileResponse.json();
    if (!profileResponse.ok) throw new Error(profile.error || 'Your account profile could not be verified.');
    if (!profile.is_approved) {
      await supabaseClient.auth.signOut();
      throw new Error('Your account is awaiting approval by a farm owner or administrator.');
    }

    applyLoggedInUser({
      id: session.user.id,
      email: session.user.email,
      name: profile.full_name || session.user.email.split('@')[0],
      role: (profile.role || 'farmer').replace(/_/g, ' ').toUpperCase(),
      roleKey: profile.role || 'farmer',
      avatarUrl: profile.avatar_url || '',
      recoveryQuestionId: profile.recovery_question_id || ''
    });
    await loadAvailableReportMonths();
    hideAuthOverlay();
  } catch (error) {
    localStorage.removeItem('smartfarm_user');
    state.currentUser = null;
    showAuthOverlay();
    if (error.message.includes('awaiting approval')) showAuthMessage(error.message, 'error');
  }
}

function showAuthOverlay() {
  const overlay = document.getElementById('authPageOverlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hideAuthOverlay() {
  const overlay = document.getElementById('authPageOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function clearSignInCredentials() {
  const loginForm = document.getElementById('customLoginForm');
  const emailInput = document.getElementById('signInUsername');
  const passwordInput = document.getElementById('signInPassword');
  if (loginForm) loginForm.reset();
  if (emailInput) emailInput.value = '';
  if (passwordInput) passwordInput.value = '';
}

function logoutUser() {
  clearSignInCredentials();
  if (supabaseClient) {
    supabaseClient.auth.signOut().catch(error => {
      console.error('Sign out failed:', error.message);
      showToast('Could not fully sign out. Please try again.');
    });
  }
  localStorage.removeItem('smartfarm_user');
  state.currentUser = null;
  updateSettingsAccess();
  showToast('Signed out from Smart-Farm.');
  showAuthOverlay();
}

function updateSettingsAccess() {
  const manageUsersButton = document.getElementById('settingsBtnManageUsers');
  const roleKey = String(state.currentUser?.roleKey || '').toLowerCase();
  const canManage = ['farm_owner', 'administrator'].includes(roleKey);
  if (manageUsersButton) manageUsersButton.hidden = !canManage;

  const reportsNavButton = document.getElementById('nav-reports');
  if (reportsNavButton) reportsNavButton.hidden = !canManage;
}

function initSettingsUI() {
  const profileForm = document.getElementById('editProfileForm');
  const photoInput = document.getElementById('editProfilePhoto');
  const photoPreview = document.getElementById('editProfilePhotoPreview');
  const photoStatus = document.getElementById('profilePhotoStatus');
  const manageUsersForm = document.getElementById('manageUsersForm');
  const usersTableBody = document.getElementById('usersTableBody');
  let selectedPhotoData = null;

  document.getElementById('settingsBtnEditProfile')?.addEventListener('click', () => {
    if (!state.currentUser) return;
    document.getElementById('editProfileName').value = state.currentUser.name;
    document.getElementById('editProfileEmail').value = state.currentUser.email;
    document.getElementById('profileSecurityQuestion').value = state.currentUser.recoveryQuestionId || 'first_school';
    document.getElementById('profileSecurityAnswer').value = '';
    if (photoPreview) photoPreview.src = state.currentUser.avatarUrl || DEFAULT_AVATAR_URL;
    if (photoInput) photoInput.value = '';
    selectedPhotoData = null;
    if (photoStatus) photoStatus.textContent = 'Choose a JPG, PNG, or WebP image up to 2 MB.';
    switchView('edit-profile');
  });

  document.getElementById('settingsBtnManageUsers')?.addEventListener('click', async () => {
    switchView('manage-users');
    await loadManageUsersList();
  });

  document.querySelectorAll('[data-return-settings]').forEach(button => {
    button.addEventListener('click', () => switchView('settings'));
  });

  photoInput?.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      photoInput.value = '';
      selectedPhotoData = null;
      photoStatus.textContent = 'Choose a JPG, PNG, or WebP image up to 2 MB.';
      return;
    }

    try {
      selectedPhotoData = await readFileAsDataUrl(file);
      photoPreview.src = selectedPhotoData;
      photoStatus.textContent = file.name;
    } catch (error) {
      selectedPhotoData = null;
      photoStatus.textContent = 'Could not read the selected image.';
    }
  });

  profileForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const fullName = document.getElementById('editProfileName').value.trim();
    try {
      const body = { full_name: fullName };
      if (selectedPhotoData) body.photo = selectedPhotoData;
      const recoveryAnswer = document.getElementById('profileSecurityAnswer').value.trim();
      if (recoveryAnswer) {
        body.recovery = {
          questionId: document.getElementById('profileSecurityQuestion').value,
          answer: recoveryAnswer
        };
      }
      const response = await authorizedApiFetch('/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Profile update failed.');

      applyLoggedInUser({
        ...state.currentUser,
        name: result.full_name,
        avatarUrl: result.avatar_url || state.currentUser.avatarUrl || '',
        recoveryQuestionId: body.recovery?.questionId || state.currentUser.recoveryQuestionId || ''
      });
      selectedPhotoData = null;
      switchView('settings');
      showToast('Profile updated.');
    } catch (error) {
      showToast(error.message);
    }
  });

  manageUsersForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = document.getElementById('usersPageStatus');
    const saveButton = document.getElementById('saveUsersButton');
    const rows = [...usersTableBody.querySelectorAll('tr')];
    const deleteCount = rows.filter(row => row.querySelector('[data-delete-user]').checked).length;
    for (const role of ['farm_owner', 'administrator']) {
      const roleCount = rows.filter(row => row.dataset.accountRole === role).length;
      const selectedRoleCount = rows.filter(row =>
        row.dataset.accountRole === role && row.querySelector('[data-delete-user]').checked
      ).length;
      if (selectedRoleCount >= roleCount && roleCount > 0) {
        status.textContent = `At least one ${role === 'farm_owner' ? 'farm owner' : 'administrator'} must remain.`;
        return;
      }
    }
    if (deleteCount && !window.confirm(`Delete ${deleteCount} selected user${deleteCount === 1 ? '' : 's'}? This cannot be undone.`)) return;

    saveButton.disabled = true;
    status.textContent = 'Saving user changes...';
    try {
      for (const row of rows) {
        const userId = row.dataset.userId;
        if (row.querySelector('[data-delete-user]').checked) {
          const response = await authorizedApiFetch(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
          const result = response.status === 204 ? {} : await response.json();
          if (!response.ok) throw new Error(result.error || `Could not delete ${userId}.`);
          continue;
        }

        const payload = { full_name: row.querySelector('[data-user-name]').value.trim() };
        if (userId !== state.currentUser?.id) {
          const roleSelect = row.querySelector('[data-user-role]');
          if (!roleSelect.disabled) payload.role = roleSelect.value;
          const approvalSelect = row.querySelector('[data-user-approved]');
          if (!approvalSelect.disabled) payload.is_approved = approvalSelect.value === 'true';
        }

        const response = await authorizedApiFetch(`/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Could not update ${userId}.`);
      }

      status.textContent = '';
      switchView('settings');
      showToast('User changes saved.');
    } catch (error) {
      status.textContent = `Some changes may already be saved. ${error.message}`;
    } finally {
      saveButton.disabled = false;
    }
  });
}

async function loadManageUsersList() {
  const tableBody = document.getElementById('usersTableBody');
  const status = document.getElementById('usersPageStatus');
  if (!tableBody || !status) return;

  status.textContent = 'Loading users...';
  tableBody.innerHTML = '';
  try {
    const response = await authorizedApiFetch('/users');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load users.');

    const ownerCount = result.users.filter(user => user.role === 'farm_owner').length;
    const administratorCount = result.users.filter(user => user.role === 'administrator').length;
    const isFarmOwner = state.currentUser?.roleKey === 'farm_owner';
    tableBody.innerHTML = result.users.map(user => {
      const ownAccount = user.id === state.currentUser?.id;
      const canDelete = !ownAccount && (isFarmOwner
        ? (user.role === 'farm_owner' ? ownerCount > 1
          : user.role === 'administrator' ? administratorCount > 1
            : true)
        : user.role !== 'farm_owner' && (user.role !== 'administrator' || administratorCount > 1));
      return `<tr data-user-id="${escapeHtml(user.id)}" data-account-role="${escapeHtml(user.role)}">
        <td><input data-user-name type="text" maxlength="40" value="${escapeHtml(user.full_name || '')}" aria-label="Name for ${escapeHtml(user.email || 'user')}"></td>
        <td>${escapeHtml(user.email || '')}</td>
        <td><select data-user-role aria-label="Role for ${escapeHtml(user.email || 'user')}" ${ownAccount || !isFarmOwner ? 'disabled' : ''}>
          <option value="farmer" ${user.role === 'farmer' ? 'selected' : ''}>Farmer</option>
          <option value="farm_owner" ${user.role === 'farm_owner' ? 'selected' : ''}>Farm Owner</option>
          <option value="administrator" ${user.role === 'administrator' ? 'selected' : ''}>Administrator</option>
        </select></td>
        <td><select data-user-approved aria-label="Approval for ${escapeHtml(user.email || 'user')}" ${ownAccount || user.is_approved ? 'disabled' : ''}>
          <option value="false" ${user.is_approved ? '' : 'selected'}>Pending</option>
          <option value="true" ${user.is_approved ? 'selected' : ''}>Approved</option>
        </select></td>
        <td><input type="checkbox" data-delete-user aria-label="Delete ${escapeHtml(user.email || 'user')}" ${canDelete ? '' : 'disabled'}></td>
      </tr>`;
    }).join('');
    status.textContent = result.users.length ? '' : 'No users found.';
  } catch (error) {
    status.textContent = error.message;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function initNotifications() {
  const button = document.getElementById('notificationBtn');
  const panel = document.getElementById('notificationsPanel');
  const closeButton = document.getElementById('closeNotificationsBtn');
  const list = document.getElementById('notificationsList');
  if (!button || !panel || !list) return;

  button.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) await loadNotifications();
  });

  closeButton?.addEventListener('click', () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('click', event => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }
  });

  list.addEventListener('click', async event => {
    const item = event.target.closest('[data-notification-id]');
    if (!item || item.classList.contains('is-read')) return;
    try {
      const response = await authorizedApiFetch(`/notifications/${encodeURIComponent(item.dataset.notificationId)}/read`, {
        method: 'POST'
      });
      if (!response.ok) throw new Error('Could not mark notification as read.');
      await loadNotifications();
    } catch (error) {
      list.dataset.error = error.message;
    }
  });
}

async function loadNotifications() {
  const list = document.getElementById('notificationsList');
  const badge = document.getElementById('notificationsBadge');
  if (!list || !badge) return;

  list.innerHTML = '<p class="notifications-empty">Loading notifications...</p>';
  try {
    const response = await authorizedApiFetch('/notifications');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load notifications.');

    badge.textContent = result.unreadCount > 9 ? '9+' : String(result.unreadCount);
    badge.hidden = result.unreadCount === 0;
    if (!result.notifications.length) {
      list.innerHTML = '<p class="notifications-empty">No recent notifications.</p>';
      return;
    }

    list.innerHTML = result.notifications.map(notification => `
      <button class="notification-item ${notification.isRead ? 'is-read' : 'is-unread'}" type="button" data-notification-id="${escapeHtml(notification.id)}">
        <span class="notification-item-title">${escapeHtml(notification.title)}</span>
        <span class="notification-item-message">${escapeHtml(notification.message)}</span>
        <time>${escapeHtml(new Date(notification.created_at).toLocaleString())}</time>
      </button>
    `).join('');
  } catch (error) {
    list.innerHTML = `<p class="notifications-empty">${escapeHtml(error.message)}</p>`;
    badge.hidden = true;
  }
}

function showAuthMessage(msg, type) {
  const box = document.getElementById('authGlobalMsg');
  if (box) {
    box.innerText = msg;
    box.className = `auth-msg-box ${type}`;
    box.style.display = 'block';
  }
}

function hideAuthMessage() {
  const box = document.getElementById('authGlobalMsg');
  if (box) box.style.display = 'none';
}

// ==================== DASHBOARD NAVIGATION ==================== //
function initNavigation() {
  const navBtns = document.querySelectorAll('.nav-item[data-view]');
  const viewPanels = document.querySelectorAll('.view-panel');
  const nestedSettingsViews = ['edit-profile', 'manage-users'];
  const viewTitles = {
    dashboard: 'Dashboard',
    reports: 'Reports',
    irrigation: 'Irrigation Control',
    crops: 'Crops & Insights',
    settings: 'Settings',
    'edit-profile': 'Edit Profile',
    'manage-users': 'Manage Users'
  };

  window.switchView = function(viewKey) {
    if (!state.currentUser) {
      showAuthOverlay();
      return;
    }
    if (!document.getElementById(`view-${viewKey}`)) return;
    const roleKey = String(state.currentUser.roleKey || '').toLowerCase();
    const canManage = ['farm_owner', 'administrator'].includes(roleKey);
    if (['reports', 'manage-users'].includes(viewKey) && !canManage) {
      showToast(viewKey === 'reports'
        ? 'Reports are available to farm owners and administrators.'
        : 'User management is available to farm owners and administrators.');
      return;
    }

    state.activeView = viewKey;
    const activeNavView = nestedSettingsViews.includes(viewKey) ? 'settings' : viewKey;

    navBtns.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === activeNavView);
    });

    viewPanels.forEach(panel => {
      panel.classList.toggle('active', panel.id === `view-${viewKey}`);
    });

    const headerTitle = document.getElementById('headerTitle');
    if (headerTitle) headerTitle.textContent = viewTitles[viewKey] || 'Smart-Farm';

    if (viewKey === 'reports') {
      if (state.availableReportMonths.length) loadMonthlyReportData();
      else loadAvailableReportMonths();
    }
    if (viewKey === 'crops') loadCropRecommendation();
    if (viewKey === 'dashboard' && state.charts.trend) {
      setTimeout(() => state.charts.trend.resize(), 100);
    }
  };

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
  });
}

// ==================== TELEMETRY & IRRIGATION ==================== //
async function loadCropRecommendation() {
  const panel = document.getElementById('cropRecommendation');
  if (!panel) return;

  panel.setAttribute('aria-busy', 'true');
  panel.innerHTML = '<p class="crop-desc-text">Calculating a recommendation from saved temperature readings...</p>';
  try {
    const response = await fetch(`${API_BASE}/telemetry/crop-insights`, { cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      if (response.status === 404) {
        throw new Error('Crop insights API not found. Restart the SmartFarm backend (smartfarm-backend/server.js), then reload this page.');
      }
      throw new Error(`Crop insights API returned an unexpected response (${response.status}).`);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load crop insights.');

    if (!Number.isFinite(result.average_temperature) || result.reading_count < 1) {
      panel.innerHTML = '<p class="crop-desc-text">No temperature readings are available for the last 3 months, so a crop cannot be recommended yet.</p>';
      return;
    }

    const averageTemperature = result.average_temperature;
    const crop = CROPS_DATA.find(item =>
      averageTemperature >= item.tempRange[0] && averageTemperature <= item.tempRange[1]
    );

    if (!crop) {
      panel.innerHTML = `<p class="crop-desc-text">The 3-month average is ${averageTemperature.toFixed(1)}°C, outside the supported crop temperature ranges. Consider a protected growing area or wait for conditions to change.</p>`;
      return;
    }

    panel.innerHTML = `
      <div class="crop-recommendation-header">
        <div>
          <span class="crop-season-badge">${crop.season}</span>
          <h3 class="crop-recommendation-name">${crop.name}</h3>
        </div>
        <div class="crop-average-temperature">
          <span>3-month average</span>
          <strong>${averageTemperature.toFixed(1)}°C</strong>
        </div>
      </div>
      <div class="crop-spotlight-inner">
        <div class="crop-image-frame">
          <img src="${crop.imageUrl}" alt="${crop.name}" loading="lazy">
        </div>
        <p class="crop-desc-text">${crop.description}</p>
      </div>
      <div class="crop-recommendation-details">
        <span>Suitable temperature: ${crop.tempRange[0]}°C–${crop.tempRange[1]}°C</span>
        <span>Recommended humidity: ${crop.idealHumidity}</span>
        <span>Based on ${result.reading_count} saved temperature readings</span>
      </div>`;
  } catch (error) {
    panel.innerHTML = `<p class="crop-desc-text">${escapeHtml(error.message)}</p>`;
  } finally {
    panel.setAttribute('aria-busy', 'false');
  }
}

function initClock() {
  const clockEl = document.getElementById('liveClock');
  setInterval(() => {
    if (clockEl) clockEl.innerText = new Date().toLocaleString();
  }, 1000);
}

async function fetchLatestTelemetry() {
  let liveReading = null;
  try {
    const res = await fetch(`${API_BASE}/telemetry/live`, { cache: 'no-store' });
    if (res.ok) {
      liveReading = await res.json();
    }
  } catch (error) {}

  const liveTimestamp = liveReading?.timestamp ? Date.parse(liveReading.timestamp) : NaN;
  const liveAge = Date.now() - liveTimestamp;
  state.isOnline = Number.isFinite(liveTimestamp) && liveAge >= -5000 && liveAge <= SENSOR_STALE_AFTER_MS;

  if (state.isOnline) {
    const timestamp = new Date(liveTimestamp).toISOString();
    state.telemetry = {
      temperature: numericReading(liveReading.temperature),
      humidity: numericReading(liveReading.humidity),
      soilMoistureA: numericReading(liveReading.soilMoistureA),
      soilMoistureB: numericReading(liveReading.soilMoistureB),
      pumpState: liveReading.pumpState || null,
      timestamp
    };

    const newestTrendReading = state.trendReadings[state.trendReadings.length - 1];
    if (newestTrendReading?.timestamp !== timestamp) {
      state.trendReadings.push({ ...state.telemetry });
      state.trendReadings = state.trendReadings.slice(-12);
    }
  } else if (Date.now() - lastHistoryFetchAt >= HISTORY_REFRESH_INTERVAL_MS) {
    lastHistoryFetchAt = Date.now();
    try {
      const response = await fetch(`${API_BASE}/telemetry/history?limit=12`, { cache: 'no-store' });
      const history = await response.json();

      if (response.ok && Array.isArray(history)) {
        state.trendReadings = history.slice().reverse().map(row => ({
          temperature: numericReading(row.temperature),
          humidity: numericReading(row.humidity),
          soilMoistureA: numericReading(row.soil_moisture_a),
          soilMoistureB: numericReading(row.soil_moisture_b),
          pumpState: row.pump_state || null,
          timestamp: row.created_at
        }));

        if (history.length > 0) {
          const latest = history[0];
          state.telemetry = {
            temperature: numericReading(latest.temperature),
            humidity: numericReading(latest.humidity),
            soilMoistureA: numericReading(latest.soil_moisture_a),
            soilMoistureB: numericReading(latest.soil_moisture_b),
            pumpState: latest.pump_state || null,
            timestamp: latest.created_at
          };
        }
      }
    } catch (error) {}
  }

  updateDashboardUI();
}

function updateDashboardUI() {
  const t = state.telemetry;
  const moistEl = document.getElementById('valMoistureA');
  const moistBEl = document.getElementById('valMoistureB');
  const tempEl = document.getElementById('valTemperature');
  const humEl = document.getElementById('valHumidity');
  const pumpEl = document.getElementById('valPumpState');

  if (moistEl) moistEl.innerHTML = `${formatReading(t.soilMoistureA, 0)} <span class="stat-unit">%</span>`;
  if (moistBEl) moistBEl.innerHTML = `${formatReading(t.soilMoistureB, 0)} <span class="stat-unit">%</span>`;
  if (tempEl) tempEl.innerHTML = `${formatReading(t.temperature, 0)} <span class="stat-unit">°C</span>`;
  if (humEl) humEl.innerHTML = `${formatReading(t.humidity, 0)} <span class="stat-unit">%</span>`;
  if (pumpEl) pumpEl.innerText = t.pumpState || '--';

  const statusText = document.getElementById('backendStatusText');
  const statusDot = document.getElementById('backendStatusDot');
  const sensorTitle = document.getElementById('sensorReadingsTitle');
  const readingTime = document.getElementById('lastSensorReadingTime');
  if (statusText) statusText.textContent = state.isOnline ? 'ESP32 Live Sync: Online' : 'Sensor not running';
  if (statusDot) statusDot.classList.toggle('offline', !state.isOnline);
  if (sensorTitle) sensorTitle.textContent = state.isOnline ? 'Live Sensor Readings' : 'Last Sensor Readings';
  if (readingTime) {
    readingTime.textContent = t.timestamp
      ? `${state.isOnline ? 'Updated' : 'Last saved'} ${new Date(t.timestamp).toLocaleString()}`
      : 'No saved readings';
  }

  const readingLabel = value => value === null || value === undefined ? 'No reading' : state.isOnline ? 'Live' : 'Last reading';
  document.getElementById('soilMoistureStatusA').textContent = readingLabel(t.soilMoistureA);
  document.getElementById('soilMoistureStatusB').textContent = readingLabel(t.soilMoistureB);
  document.getElementById('temperatureStatus').textContent = readingLabel(t.temperature);
  document.getElementById('humidityStatus').textContent = readingLabel(t.humidity);
  document.getElementById('pumpStateSubtitle').textContent = t.pumpState
    ? state.isOnline ? (String(t.pumpState).toUpperCase() === 'ON' ? 'Pumping Active' : 'System Idle') : 'Last reported'
    : 'No saved reading';

  const liveMoist = document.getElementById('liveSensorMoistA');
  const liveMoistB = document.getElementById('liveSensorMoistB');
  const liveTemp = document.getElementById('liveSensorTemp');
  const liveHum = document.getElementById('liveSensorHum');

  if (liveMoist) liveMoist.innerText = `${formatReading(t.soilMoistureA, 1)} %`;
  if (liveMoistB) liveMoistB.innerText = `${formatReading(t.soilMoistureB, 1)} %`;
  if (liveTemp) liveTemp.innerText = `${formatReading(t.temperature, 1)} °C`;
  if (liveHum) liveHum.innerText = `${formatReading(t.humidity, 1)} %`;

  updateTrendChart();
}

function numericReading(value) {
  if (value === null || value === undefined || value === '') return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatReading(value, decimals) {
  const numericValue = numericReading(value);
  return numericValue === null ? '--' : numericValue.toFixed(decimals);
}

function initIrrigationControls() {
  const btnStart = document.getElementById('btnStartIrrigation');
  const btnStop = document.getElementById('btnStopIrrigation');

  async function sendPumpCommand(cmd) {
    const previousState = state.telemetry.pumpState;
    state.telemetry.pumpState = cmd;
    updateDashboardUI();

    try {
      const response = await authorizedApiFetch('/pump/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Pump command failed.');
      showToast(`Irrigation set to ${cmd}`);
    } catch (error) {
      state.telemetry.pumpState = previousState;
      updateDashboardUI();
      showToast(error.message);
    }
  }

  if (btnStart) btnStart.addEventListener('click', () => sendPumpCommand('ON'));
  if (btnStop) btnStop.addEventListener('click', () => sendPumpCommand('OFF'));
}

// ==================== CHARTS & TOAST NOTIFICATIONS ==================== //
function initTrendChart() {
  const canvas = document.getElementById('soilMoistureTrendCanvas');
  if (!canvas) return;
  state.charts.trend = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Plot A %', data: [], borderColor: '#195c3b', fill: false, tension: 0.3, spanGaps: false },
        { label: 'Plot B %', data: [], borderColor: '#0284c7', fill: false, tension: 0.3, spanGaps: false }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

function updateTrendChart() {
  const chart = state.charts.trend;
  if (!chart) return;

  const readings = state.trendReadings.slice(-12);
  chart.data.labels = readings.map(reading => {
    const date = new Date(reading.timestamp);
    return Number.isFinite(date.getTime())
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '--';
  });
  chart.data.datasets[0].data = readings.map(reading => reading.soilMoistureA);
  chart.data.datasets[1].data = readings.map(reading => reading.soilMoistureB);
  chart.update('none');
}

function initReportCharts() {
  const ctxSoil = document.getElementById('reportSoilCanvas')?.getContext('2d');
  if (ctxSoil) {
    state.charts.reportSoil = new Chart(ctxSoil, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Soil Moisture (%)', data: [], borderColor: '#195c3b', spanGaps: false }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  const ctxTemp = document.getElementById('reportTempCanvas')?.getContext('2d');
  if (ctxTemp) {
    state.charts.reportTemp = new Chart(ctxTemp, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Temperature (°C)', data: [], borderColor: '#ea580c', spanGaps: false }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  const ctxHum = document.getElementById('reportHumCanvas')?.getContext('2d');
  if (ctxHum) {
    state.charts.reportHum = new Chart(ctxHum, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Humidity (%)', data: [], borderColor: '#0284c7', spanGaps: false }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
}

function initReportControls() {
  document.getElementById('reportMonthSelect')?.addEventListener('change', loadMonthlyReportData);
  document.getElementById('downloadMonthlyReport')?.addEventListener('click', downloadMonthlyReport);
}

function currentReportMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatReportMonth(month) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${month}-01T00:00:00Z`));
}

async function loadAvailableReportMonths() {
  const status = document.getElementById('reportsStatus');
  const monthSelect = document.getElementById('reportMonthSelect');
  const downloadButton = document.getElementById('downloadMonthlyReport');
  if (!monthSelect) return;
  monthSelect.disabled = true;
  if (downloadButton) downloadButton.disabled = true;
  if (status) status.textContent = 'Loading months with saved readings...';

  try {
    const response = await authorizedApiFetch('/telemetry/reports/months');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load available report months.');
    if (!Array.isArray(result.months)) throw new Error('The server returned an invalid list of report months.');

    state.availableReportMonths = result.months.filter(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month));
    monthSelect.replaceChildren();
    if (!state.availableReportMonths.length) {
      monthSelect.add(new Option('No months with saved data', ''));
      state.monthlyReport = null;
      updateMonthlyReportSummary(null);
      updateMonthlyReportCharts(null);
      if (status) status.textContent = 'No saved sensor readings are available for a monthly report.';
      return;
    }

    state.availableReportMonths.forEach(month => monthSelect.add(new Option(formatReportMonth(month), month)));
    const currentMonth = currentReportMonth();
    monthSelect.value = state.availableReportMonths.includes(currentMonth)
      ? currentMonth
      : state.availableReportMonths[0];
    monthSelect.disabled = false;
    await loadMonthlyReportData();
  } catch (error) {
    monthSelect.replaceChildren(new Option('Could not load available months', ''));
    if (status) status.textContent = error.message;
  }
}

async function loadMonthlyReportData() {
  const status = document.getElementById('reportsStatus');
  const monthSelect = document.getElementById('reportMonthSelect');
  const downloadButton = document.getElementById('downloadMonthlyReport');
  const month = monthSelect?.value;
  if (!month) return;

  if (status) status.textContent = `Loading ${formatReportMonth(month)} report...`;
  if (downloadButton) downloadButton.disabled = true;
  try {
    const response = await authorizedApiFetch(`/telemetry/reports/monthly?month=${encodeURIComponent(month)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load report data.');
    if (monthSelect.value !== month) return;
    if (!result.readingCount) {
      state.monthlyReport = null;
      updateMonthlyReportSummary(null);
      updateMonthlyReportCharts(null);
      throw new Error(`${formatReportMonth(month)} has no saved readings.`);
    }
    state.monthlyReport = result;
    updateMonthlyReportSummary(result);
    updateMonthlyReportCharts(result);
    if (downloadButton) downloadButton.disabled = false;
    if (status) {
      status.textContent = `Charts show daily averages.`;
    }
  } catch (error) {
    if (monthSelect.value === month && status) status.textContent = error.message;
  }
}

function updateMonthlyReportSummary(report) {
  const averages = report?.averages || {};
  document.getElementById('monthlyAverageTemperature').textContent =
    averages.temperature === null || averages.temperature === undefined ? '--' : `${averages.temperature.toFixed(1)} °C`;
  document.getElementById('monthlyAverageHumidity').textContent =
    averages.humidity === null || averages.humidity === undefined ? '--' : `${averages.humidity.toFixed(1)} %`;
  document.getElementById('monthlyAverageSoil').textContent =
    averages.soilMoisture === null || averages.soilMoisture === undefined ? '--' : `${averages.soilMoisture.toFixed(1)} %`;
}

function updateMonthlyReportCharts(report) {
  const chartUpdates = [
    [state.charts.reportSoil, report?.soilMoisture || []],
    [state.charts.reportTemp, report?.temperature || []],
    [state.charts.reportHum, report?.humidity || []]
  ];
  chartUpdates.forEach(([chart, values]) => {
    if (!chart) return;
    chart.data.labels = report?.labels || [];
    chart.data.datasets[0].data = values;
    chart.update();
  });
}

function downloadMonthlyReport() {
  const report = state.monthlyReport;
  if (!report) return;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('Allow pop-ups to download the monthly report as PDF.');
    return;
  }

  const chartImages = [
    ['Average soil moisture by day', state.charts.reportSoil],
    ['Average temperature by day', state.charts.reportTemp],
    ['Average humidity by day', state.charts.reportHum]
  ].filter(([, chart]) => chart).map(([title, chart]) => {
    chart.resize();
    chart.update('none');
    return `
    <section class="chart">
      <h2>${title}</h2>
      <img src="${chart.toBase64Image()}" alt="${title}">
    </section>`;
  }).join('');
  const averages = report.averages;
  const reportTitle = formatReportMonth(report.month);
  const printableHtml = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>SmartFarm Monthly Report - ${reportTitle}</title>
      <style>
        body { font: 14px Arial, sans-serif; color: #183329; margin: 32px; }
        h1 { margin: 0 0 8px; }
        .subtitle { color: #52645c; margin-bottom: 24px; }
        .summary { display: flex; gap: 16px; margin-bottom: 24px; }
        .stat { flex: 1; border: 1px solid #d8e1dc; border-radius: 8px; padding: 14px; }
        .stat span { display: block; color: #52645c; margin-bottom: 8px; }
        .stat strong { font-size: 20px; }
        .chart { page-break-inside: avoid; margin: 18px 0; }
        .chart img { display: block; width: 100%; max-height: 300px; object-fit: contain; }
        @media print { body { margin: 14mm; } }
      </style>
    </head>
    <body>
      <h1>SmartFarm Monthly Report</h1>
      <p class="subtitle">${reportTitle} · ${report.readingCount} saved sensor readings</p>
      <div class="summary">
        <div class="stat"><span>Average temperature</span><strong>${averages.temperature === null ? '--' : `${averages.temperature.toFixed(1)} °C`}</strong></div>
        <div class="stat"><span>Average humidity</span><strong>${averages.humidity === null ? '--' : `${averages.humidity.toFixed(1)} %`}</strong></div>
        <div class="stat"><span>Average soil moisture</span><strong>${averages.soilMoisture === null ? '--' : `${averages.soilMoisture.toFixed(1)} %`}</strong></div>
      </div>
      ${chartImages}
      <script>window.addEventListener('load', () => { window.print(); });</script>
    </body>
    </html>`;
  printWindow.document.open();
  printWindow.document.write(printableHtml);
  printWindow.document.close();
}

function showToast(message) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}