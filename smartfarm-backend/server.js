require('dotenv').config();
const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..')));

// 1. Supabase Initialization
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: ws }
});

// 2. MQTT Client Setup
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);

const TOPIC_TELEMETRY = 'smartfarm/telemetry';
const TOPIC_CONTROL   = 'smartfarm/pump/control';
const RECOVERY_QUESTION_IDS = new Set(['first_school', 'birth_city', 'first_pet', 'childhood_friend']);
const recoveryAttemptsByIp = new Map();

// Memory cache for latest telemetry reading (for fast REST API responses)
let latestTelemetry = {
  temperature: 0,
  humidity: 0,
  soilMoistureA: 0,
  soilMoistureB: 0,
  pumpState: 'OFF',
  trigger: 'NONE',
  timestamp: null
};

// 3. MQTT Event Callbacks
mqttClient.on('connect', () => {
  console.log('Connected to Mosquitto MQTT Broker');
  mqttClient.subscribe(TOPIC_TELEMETRY, (err) => {
    if (!err) console.log(`Subscribed to ${TOPIC_TELEMETRY}`);
  });
});

mqttClient.on('message', async (topic, message) => {
  if (topic === TOPIC_TELEMETRY) {
    try {
      const data = JSON.parse(message.toString());
      const { initiatedByUserId, ...telemetryData } = data;
      const previousPumpState = latestTelemetry.timestamp
        ? String(latestTelemetry.pumpState).toUpperCase()
        : null;
      latestTelemetry = { ...telemetryData, timestamp: new Date() };
      const currentPumpState = String(data.pumpState || '').toUpperCase();

      if (['ON', 'OFF'].includes(previousPumpState) && ['ON', 'OFF'].includes(currentPumpState) && previousPumpState !== currentPumpState) {
        const started = currentPumpState === 'ON';
        await createNotification(
          started ? 'pump_started' : 'pump_stopped',
          started ? 'Pump started' : 'Pump stopped',
          started ? 'The irrigation pump has started running.' : 'The irrigation pump has stopped.',
          'all'
        );
      }

      console.log('[MQTT LIVE RECV]:', latestTelemetry);

      // Save to Supabase immediately if an automated or manual event occurred
      if (data.trigger === 'EVENT_AUTO' || data.trigger === 'EVENT_MANUAL') {
        console.log(`[IMMEDIATE LOG] Trigger event detected: ${data.trigger}`);
        await saveToSupabase({ ...telemetryData, initiatedByUserId });
      }
    } catch (err) {
      console.error('Error parsing MQTT payload:', err.message);
    }
  }
});

// 4. Database Helper Function
async function saveToSupabase(data) {
  const { error } = await supabase.from('sensor_logs').insert([{
    temperature: data.temperature,
    humidity: data.humidity,
    soil_moisture_a: data.soilMoistureA,
    soil_moisture_b: data.soilMoistureB,
    pump_state: data.pumpState,
    trigger_type: data.trigger || 'PERIODIC',
    initiated_by_user_id: data.trigger === 'EVENT_MANUAL'
      ? data.initiatedByUserId || null
      : null
  }]);

  if (error) console.error('[SUPABASE ERROR]:', error.message);
  else console.log('[SUPABASE SUCCESS] Log saved.');
}

async function createNotification(eventType, title, message, audience) {
  const { error } = await supabase.from('notifications').insert({
    event_type: eventType,
    title,
    message,
    audience
  });
  if (error) console.error('[NOTIFICATION ERROR]:', error.message);
}

// 5. Periodic DB Buffer (Saves a record every 5 minutes)
setInterval(() => {
  if (latestTelemetry.timestamp) {
    console.log('[PERIODIC LOG] Saving scheduled telemetry record...');
    saveToSupabase({ ...latestTelemetry, trigger: 'PERIODIC' });
  }
}, 5 * 60 * 1000);

// 6. REST API Endpoints for Dashboard
// GET: Fetch latest real-time sensor reading
app.get('/api/telemetry/live', (req, res) => {
  res.json(latestTelemetry);
});

// GET: Fetch historical telemetry logs from Supabase
app.get('/api/telemetry/history', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data, error } = await supabase
    .from('sensor_logs')
    .select('id, temperature, humidity, soil_moisture_a, soil_moisture_b, pump_state, trigger_type, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/telemetry/crop-insights', async (req, res) => {
  try {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd);
    const originalDay = periodStart.getUTCDate();
    periodStart.setUTCDate(1);
    periodStart.setUTCMonth(periodStart.getUTCMonth() - 3);
    const lastDayOfStartMonth = new Date(Date.UTC(
      periodStart.getUTCFullYear(),
      periodStart.getUTCMonth() + 1,
      0
    )).getUTCDate();
    periodStart.setUTCDate(Math.min(originalDay, lastDayOfStartMonth));

    const pageSize = 1000;
    let offset = 0;
    let temperatureSum = 0;
    let readingCount = 0;

    while (true) {
      const { data, error } = await supabase
        .from('sensor_logs')
        .select('temperature')
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString())
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) return res.status(500).json({ error: error.message });
      if (!Array.isArray(data)) throw new Error('Could not read saved temperature readings.');

      data.forEach(row => {
        const temperature = Number(row.temperature);
        if (row.temperature !== null && row.temperature !== undefined && row.temperature !== '' && Number.isFinite(temperature)) {
          temperatureSum += temperature;
          readingCount += 1;
        }
      });

      if (data.length < pageSize) break;
      offset += pageSize;
    }

    res.json({
      average_temperature: readingCount ? temperatureSum / readingCount : null,
      reading_count: readingCount,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/telemetry/reports/months', authenticateRequest, requireApprovedUser, requireManager, async (req, res) => {
  try {
    const availableMonths = new Set();
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from('sensor_logs')
        .select('created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (error) return res.status(500).json({ error: error.message });
      if (!Array.isArray(data)) throw new Error('Could not read saved sensor reading dates.');

      data.forEach(row => {
        const timestamp = new Date(row.created_at);
        if (Number.isFinite(timestamp.getTime())) {
          const month = `${timestamp.getUTCFullYear()}-${String(timestamp.getUTCMonth() + 1).padStart(2, '0')}`;
          availableMonths.add(month);
        }
      });

      if (data.length < pageSize) break;
      offset += pageSize;
    }

    res.json({ months: [...availableMonths].sort().reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/telemetry/reports/monthly', authenticateRequest, requireApprovedUser, requireManager, async (req, res) => {
  try {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });

    const year = Number(match[1]);
    const monthNumber = Number(match[2]);
    const periodStart = new Date(Date.UTC(year, monthNumber - 1, 1));
    const periodEnd = new Date(Date.UTC(year, monthNumber, 1));
    const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const dailyAverages = Array.from({ length: dayCount }, () => ({
      soilMoisture: { sum: 0, count: 0 },
      temperature: { sum: 0, count: 0 },
      humidity: { sum: 0, count: 0 }
    }));
    const totals = {
      soilMoisture: { sum: 0, count: 0 },
      temperature: { sum: 0, count: 0 },
      humidity: { sum: 0, count: 0 }
    };
    const pageSize = 1000;
    let offset = 0;
    let readingCount = 0;

    while (true) {
      const { data, error } = await supabase
        .from('sensor_logs')
        .select('created_at, soil_moisture_a, soil_moisture_b, temperature, humidity')
        .gte('created_at', periodStart.toISOString())
        .lt('created_at', periodEnd.toISOString())
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) return res.status(500).json({ error: error.message });
      if (!Array.isArray(data)) throw new Error('Could not read monthly sensor readings.');
      readingCount += data.length;

      data.forEach(row => {
        const timestamp = new Date(row.created_at);
        const dayIndex = timestamp.getUTCDate() - 1;
        if (!Number.isFinite(timestamp.getTime()) || dayIndex < 0 || dayIndex >= dayCount) return;

        const bucket = dailyAverages[dayIndex];
        const soilValues = [row.soil_moisture_a, row.soil_moisture_b]
          .filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
          .map(Number);
        if (soilValues.length) {
          const readingAverage = soilValues.reduce((sum, value) => sum + value, 0) / soilValues.length;
          bucket.soilMoisture.sum += readingAverage;
          bucket.soilMoisture.count += 1;
          totals.soilMoisture.sum += readingAverage;
          totals.soilMoisture.count += 1;
        }

        ['temperature', 'humidity'].forEach(metric => {
          const value = row[metric];
          if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) {
            const numericValue = Number(value);
            bucket[metric].sum += numericValue;
            bucket[metric].count += 1;
            totals[metric].sum += numericValue;
            totals[metric].count += 1;
          }
        });
      });

      if (data.length < pageSize) break;
      offset += pageSize;
    }

    const average = metric => totals[metric].count
      ? Number((totals[metric].sum / totals[metric].count).toFixed(1))
      : null;
    const dailyAverage = metric => dailyAverages.map(bucket => (
      bucket[metric].count
        ? Number((bucket[metric].sum / bucket[metric].count).toFixed(1))
        : null
    ));

    res.json({
      month,
      labels: dailyAverages.map((_, index) => String(index + 1)),
      soilMoisture: dailyAverage('soilMoisture'),
      temperature: dailyAverage('temperature'),
      humidity: dailyAverage('humidity'),
      averages: {
        soilMoisture: average('soilMoisture'),
        temperature: average('temperature'),
        humidity: average('humidity')
      },
      readingCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Send pump control command (ON / OFF / AUTO)
app.post('/api/pump/control', authenticateRequest, requireApprovedUser, (req, res) => {
  const { command } = req.body;

  if (!['ON', 'OFF', 'AUTO'].includes(command)) {
    return res.status(400).json({ error: 'Invalid command. Use ON, OFF, or AUTO.' });
  }

  const controlMessage = JSON.stringify({
    command,
    initiatedByUserId: req.authUser.id
  });
  mqttClient.publish(TOPIC_CONTROL, controlMessage, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to publish MQTT message' });
    console.log(`[API CONTROL COMMAND SENT]: ${command}`);
    res.json({ status: 'Success', message: `Pump command '${command}' published.` });
  });
});

// GET: Config for frontend Supabase connection
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

app.post('/api/auth/recovery/question', limitPasswordRecoveryAttempts, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!email) return res.json({ questionId: null });

  try {
    const { data: questionId, error } = await supabase.rpc('get_account_recovery_question', {
      p_email: email
    });
    if (error) {
      console.error('[RECOVERY QUESTION ERROR]:', error.message);
      return res.status(503).json({ error: 'Could not load the recovery question. Try again later.' });
    }
    res.json({ questionId: questionId || null });
  } catch (err) {
    console.error('[RECOVERY QUESTION ERROR]:', err.message);
    res.status(503).json({ error: 'Could not load the recovery question. Try again later.' });
  }
});

app.post('/api/auth/recovery', limitPasswordRecoveryAttempts, async (req, res) => {
  const genericMessage = 'If the information matches an account, a password recovery email will be sent.';
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const questionId = req.body.questionId;
  const answer = typeof req.body.answer === 'string' ? req.body.answer.trim() : '';

  if (!email) return res.json({ message: genericMessage });

  try {
    const { data: hasRecovery, error: lookupError } = await supabase.rpc('account_recovery_exists', {
      p_email: email
    });
    if (lookupError) {
      console.error('[RECOVERY LOOKUP ERROR]:', lookupError.message);
      return res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
    }

    let maySendRecoveryEmail = !hasRecovery;
    if (hasRecovery && RECOVERY_QUESTION_IDS.has(questionId) && answer.length >= 2 && answer.length <= 40) {
      const { data: verified, error: verifyError } = await supabase.rpc('verify_account_recovery', {
        p_email: email,
        p_question_id: questionId,
        p_answer: answer
      });
      if (verifyError) {
        console.error('[RECOVERY VERIFY ERROR]:', verifyError.message);
        return res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
      }
      maySendRecoveryEmail = verified === true;
    }

    if (maySendRecoveryEmail) {
      const redirectTo = new URL(process.env.PASSWORD_RESET_REDIRECT_URL || 'http://localhost:5001/');
      redirectTo.searchParams.set('recovery', '1');
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: redirectTo.toString()
      });
      if (resetError) console.error('[RECOVERY EMAIL ERROR]:', resetError.message);
    }

    res.json({ message: genericMessage });
  } catch (err) {
    console.error('[RECOVERY ERROR]:', err.message);
    res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
  }
});

async function authenticateRequest(req, res, next) {
  const authorization = req.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Sign-in is required.' });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session is invalid or expired.' });

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, role, is_approved, avatar_url, avatar_path')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) return res.status(500).json({ error: profileError.message });
    if (!profile) return res.status(403).json({ error: 'Account profile is not available.' });

    req.authUser = user;
    req.profile = profile;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function requireApprovedUser(req, res, next) {
  if (req.profile.is_approved !== true) {
    return res.status(403).json({ error: 'Account is awaiting approval.' });
  }
  next();
}

function requireManager(req, res, next) {
  if (!['farm_owner', 'administrator'].includes(req.profile.role)) {
    return res.status(403).json({ error: 'Farm owner or administrator access is required.' });
  }
  next();
}

function hasValidImageSignature(imageType, imageData) {
  if (imageType === 'jpeg') return imageData.length >= 3 && imageData[0] === 0xff && imageData[1] === 0xd8 && imageData[2] === 0xff;
  if (imageType === 'png') return imageData.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return imageType === 'webp' && imageData.length >= 12 && imageData.toString('ascii', 0, 4) === 'RIFF' && imageData.toString('ascii', 8, 12) === 'WEBP';
}

function limitPasswordRecoveryAttempts(req, res, next) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const clientIp = req.ip || 'unknown';

  for (const [ip, entry] of recoveryAttemptsByIp) {
    if (entry.expiresAt <= now) recoveryAttemptsByIp.delete(ip);
  }

  const attempt = recoveryAttemptsByIp.get(clientIp);
  if (attempt && attempt.count >= 5) {
    return res.status(429).json({ error: 'Too many recovery attempts. Try again later.' });
  }

  if (!attempt || attempt.expiresAt <= now) {
    recoveryAttemptsByIp.set(clientIp, { count: 1, expiresAt: now + windowMs });
  } else {
    attempt.count += 1;
  }
  next();
}

app.get('/api/profile', authenticateRequest, async (req, res) => {
  const { data: recovery } = await supabase
    .from('account_recovery')
    .select('question_id')
    .eq('user_id', req.authUser.id)
    .maybeSingle();

  res.json({
    ...req.profile,
    email: req.authUser.email,
    recovery_question_id: recovery?.question_id || null
  });
});

app.patch('/api/profile', authenticateRequest, requireApprovedUser, async (req, res) => {
  try {
    const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
    if (!fullName || fullName.length > 40) {
      return res.status(400).json({ error: 'Full name must be between 1 and 40 characters.' });
    }

    if (req.body.recovery !== undefined) {
      const questionId = req.body.recovery?.questionId;
      const answer = typeof req.body.recovery?.answer === 'string' ? req.body.recovery.answer.trim() : '';
      if (!RECOVERY_QUESTION_IDS.has(questionId) || answer.length < 2 || answer.length > 40) {
        return res.status(400).json({ error: 'Choose a question and enter an answer between 2 and 40 characters.' });
      }

      const { error: recoveryError } = await supabase.rpc('save_account_recovery', {
        p_user_id: req.authUser.id,
        p_question_id: questionId,
        p_answer: answer
      });
      if (recoveryError) return res.status(500).json({ error: recoveryError.message });
    }

    const updates = { full_name: fullName };
    if (req.body.photo !== undefined) {
      const photoMatch = typeof req.body.photo === 'string'
        ? req.body.photo.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/)
        : null;
      if (!photoMatch) return res.status(400).json({ error: 'Choose a JPG, PNG, or WebP image.' });

      const imageType = photoMatch[1];
      const imageData = Buffer.from(photoMatch[2], 'base64');
      if (imageData.length === 0 || imageData.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'Profile photos must be 2 MB or smaller.' });
      }
      if (!hasValidImageSignature(imageType, imageData)) {
        return res.status(400).json({ error: 'The selected file is not a valid image.' });
      }

      const extension = imageType === 'jpeg' ? 'jpg' : imageType;
      const avatarPath = `${req.authUser.id}/avatar-${Date.now()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from('profile-photos')
        .upload(avatarPath, imageData, { contentType: `image/${imageType}`, upsert: true });
      if (uploadError) return res.status(502).json({ error: `Could not upload profile photo: ${uploadError.message}` });

      const { data: publicUrlData } = supabase.storage.from('profile-photos').getPublicUrl(avatarPath);
      updates.avatar_url = publicUrlData.publicUrl;
      updates.avatar_path = avatarPath;
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.authUser.id)
      .select('id, full_name, role, is_approved, avatar_url')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (updates.avatar_path && req.profile.avatar_path) {
      await supabase.storage.from('profile-photos').remove([req.profile.avatar_path]);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', authenticateRequest, requireApprovedUser, requireManager, async (req, res) => {
  try {
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, role, is_approved, avatar_url, avatar_path')
      .order('full_name');
    if (profileError) return res.status(500).json({ error: profileError.message });

    const { data: authData, error: authError } = await supabase.auth.admin.listUsers();
    if (authError) return res.status(500).json({ error: authError.message });

    const emailById = new Map((authData.users || []).map(user => [user.id, user.email]));
    res.json({
      users: profiles.map(profile => ({ ...profile, email: emailById.get(profile.id) || '' }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/:id', authenticateRequest, requireApprovedUser, requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    if (Object.hasOwn(req.body, 'full_name')) {
      const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
      if (!fullName || fullName.length > 40) {
        return res.status(400).json({ error: 'Full name must be between 1 and 40 characters.' });
      }
      updates.full_name = fullName;
    }

    if (Object.hasOwn(req.body, 'role')) {
      if (req.profile.role !== 'farm_owner') {
        return res.status(403).json({ error: 'Only a farm owner can change user roles.' });
      }
      if (id === req.authUser.id) return res.status(400).json({ error: 'You cannot change your own role.' });
      if (!['farmer', 'farm_owner', 'administrator'].includes(req.body.role)) {
        return res.status(400).json({ error: 'Invalid role.' });
      }

      const { data: targetProfile, error: targetError } = await supabase
        .from('profiles')
        .select('id, role')
        .eq('id', id)
        .maybeSingle();
      if (targetError) return res.status(500).json({ error: targetError.message });
      if (!targetProfile) return res.status(404).json({ error: 'User profile was not found.' });

      if (targetProfile.role !== req.body.role && ['farm_owner', 'administrator'].includes(targetProfile.role)) {
        const { count, error: countError } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', targetProfile.role);
        if (countError) return res.status(500).json({ error: countError.message });
        if (count <= 1) {
          return res.status(409).json({
            error: `The last ${targetProfile.role === 'farm_owner' ? 'farm owner' : 'administrator'} cannot be removed.`
          });
        }
      }
      updates.role = req.body.role;
    }

    if (Object.hasOwn(req.body, 'is_approved')) {
      if (id === req.authUser.id) return res.status(400).json({ error: 'You cannot change your own approval status.' });
      if (typeof req.body.is_approved !== 'boolean') {
        return res.status(400).json({ error: 'Approval status must be true or false.' });
      }

      const { data: targetProfile, error: targetError } = await supabase
        .from('profiles')
        .select('is_approved')
        .eq('id', id)
        .maybeSingle();
      if (targetError) return res.status(500).json({ error: targetError.message });
      if (!targetProfile) return res.status(404).json({ error: 'User profile was not found.' });
      if (targetProfile.is_approved) {
        return res.status(409).json({ error: 'Approval cannot be changed after a user has been approved.' });
      }
      updates.is_approved = req.body.is_approved;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid user changes were provided.' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', id)
      .select('id, full_name, role, is_approved')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', authenticateRequest, requireApprovedUser, requireManager, async (req, res) => {
  const { id } = req.params;
  if (id === req.authUser.id) {
    return res.status(400).json({ error: 'You cannot delete your own account from Manage Users.' });
  }

  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role, avatar_path')
      .eq('id', id)
      .maybeSingle();
    if (profileError) return res.status(500).json({ error: profileError.message });
    if (!profile) return res.status(404).json({ error: 'User profile was not found.' });

    if (profile.role === 'farm_owner' && req.profile.role !== 'farm_owner') {
      return res.status(403).json({ error: 'Only a farm owner can delete another farm owner.' });
    }
    if (['farm_owner', 'administrator'].includes(profile.role)) {
      const { count, error: countError } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', profile.role);
      if (countError) return res.status(500).json({ error: countError.message });
      if (count <= 1) {
        return res.status(409).json({
          error: `The last ${profile.role === 'farm_owner' ? 'farm owner' : 'administrator'} cannot be deleted.`
        });
      }
    }

    const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(id);
    if (deleteAuthError) return res.status(500).json({ error: deleteAuthError.message });

    const { error: deleteProfileError } = await supabase.from('profiles').delete().eq('id', id);
    if (deleteProfileError) {
      console.error('[USER DELETE PROFILE ERROR]:', deleteProfileError.message);
      return res.status(500).json({ error: 'Auth account was deleted, but profile cleanup failed.' });
    }

    if (profile.avatar_path) {
      const { error: photoError } = await supabase.storage.from('profile-photos').remove([profile.avatar_path]);
      if (photoError) console.error('[USER DELETE PHOTO ERROR]:', photoError.message);
    }

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications', authenticateRequest, requireApprovedUser, async (req, res) => {
  try {
    let query = supabase
      .from('notifications')
      .select('id, event_type, title, message, audience, created_at')
      .order('created_at', { ascending: false })
      .limit(30);

    if (['farm_owner', 'administrator'].includes(req.profile.role)) {
      query = query.in('audience', ['all', 'managers']);
    } else {
      query = query.eq('audience', 'all');
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    let readNotificationIds = new Set();
    if (data.length > 0) {
      const { data: readRows, error: readError } = await supabase
        .from('notification_reads')
        .select('notification_id')
        .eq('user_id', req.authUser.id)
        .in('notification_id', data.map(notification => notification.id));
      if (readError) return res.status(500).json({ error: readError.message });
      readNotificationIds = new Set(readRows.map(row => String(row.notification_id)));
    }

    const notifications = data.map(notification => ({
      ...notification,
      isRead: readNotificationIds.has(String(notification.id))
    }));
    res.json({
      notifications,
      unreadCount: notifications.filter(notification => !notification.isRead).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:id/read', authenticateRequest, requireApprovedUser, async (req, res) => {
  try {
    const { data: notification, error: selectError } = await supabase
      .from('notifications')
      .select('id, audience')
      .eq('id', req.params.id)
      .maybeSingle();
    if (selectError) return res.status(500).json({ error: selectError.message });
    if (!notification || (notification.audience === 'managers' && !['farm_owner', 'administrator'].includes(req.profile.role))) {
      return res.status(404).json({ error: 'Notification was not found.' });
    }

    const { error: readError } = await supabase
      .from('notification_reads')
      .upsert({
        notification_id: notification.id,
        user_id: req.authUser.id
      }, {
        onConflict: 'notification_id,user_id',
        ignoreDuplicates: true
      });
    if (readError) return res.status(500).json({ error: readError.message });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Device status
app.get('/api/devices', (req, res) => {
  const isOnline = latestTelemetry.timestamp && (Date.now() - new Date(latestTelemetry.timestamp).getTime() < 30000);
  res.json({
    devices: [
      {
        id: 'ESP32-FARM-01',
        name: 'SmartFarm ESP32 Main Node',
        type: 'Irrigation & Telemetry Controller',
        status: isOnline ? 'Online' : 'Connected',
        lastSeen: latestTelemetry.timestamp || new Date().toISOString(),
        firmware: 'v2.4.1-esp32',
        ip: '192.168.1.142',
        telemetryTopic: TOPIC_TELEMETRY,
        controlTopic: TOPIC_CONTROL,
        sensors: ['Soil Moisture Lot 1', 'Soil Moisture Lot 2', 'DHT22 Temp & Humidity', 'Relay 5V Pump']
      }
    ]
  });
});

// Start Server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`SmartFarm Middleware Server running on http://localhost:${PORT}`);
});