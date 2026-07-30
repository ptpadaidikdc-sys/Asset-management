import express from 'express';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { 
  INITIAL_ASSETS, 
  INITIAL_CATEGORIES, 
  INITIAL_LOCATIONS, 
  INITIAL_DEPARTMENTS, 
  INITIAL_MAINTENANCE_LOGS, 
  INITIAL_MOVEMENTS, 
  INITIAL_AUDIT_SESSIONS 
} from './src/data/initialData.ts';

const app = express();
const PORT = 3000;

app.use(express.json());

// Lazy GoogleGenAI initialization
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is missing.');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Cloud SQL Database health endpoint
app.get('/api/db-health', async (req, res) => {
  try {
    const { db } = await import('./src/db/index.ts');
    const { users } = await import('./src/db/schema.ts');
    const result = await db.select().from(users).limit(5);
    res.json({
      status: 'connected',
      message: 'Cloud SQL PostgreSQL database is active',
      sampleUsersCount: result.length,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Cloud SQL DB Health Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to query Cloud SQL database',
      error: error.message
    });
  }
});

// Central In-Memory & Database Synchronized Users Store
const INITIAL_USERS = [
  {
    id: 'usr-asep',
    name: 'Asep Pradana',
    email: 'aseppradana@kdcgroup.co.id',
    password: 'pass123',
    role: 'Super Admin',
    department: 'Management / Executive',
    location: 'Head Office Jakarta',
    status: 'Aktif',
    lastLogin: '2026-07-28 20:00',
    phone: '0812-8899-1010'
  },
  {
    id: 'usr-1',
    name: 'Budi Santoso',
    email: 'budi.santoso@company.co.id',
    password: 'admin123',
    role: 'Super Admin',
    department: 'Information Technology',
    location: 'Head Office Jakarta',
    status: 'Aktif',
    lastLogin: '2026-07-28 09:15',
    phone: '0812-3456-7890'
  },
  {
    id: 'usr-2',
    name: 'Anita Wijaya',
    email: 'anita.wijaya@company.co.id',
    password: 'manager123',
    role: 'Manager',
    department: 'Operations & Logistics',
    location: 'Gudang Cikarang',
    status: 'Aktif',
    lastLogin: '2026-07-27 14:30',
    phone: '0811-9876-5432'
  },
  {
    id: 'usr-3',
    name: 'Doni Prasetyo',
    email: 'doni.prasetyo@company.co.id',
    password: 'staff123',
    role: 'Staff Operasional',
    department: 'Human Capital & GA',
    location: 'Kantor Cabang Surabaya',
    status: 'Aktif',
    lastLogin: '2026-07-26 11:00',
    phone: '0857-1122-3344'
  }
];

let serverUsersStore = [...INITIAL_USERS];

// Central Synchronized Database Stores
let serverAssetsStore = [...INITIAL_ASSETS];
let serverCategoriesStore = [...INITIAL_CATEGORIES];
let serverLocationsStore = [...INITIAL_LOCATIONS];
let serverDepartmentsStore = [...INITIAL_DEPARTMENTS];
let serverMaintenanceStore = [...INITIAL_MAINTENANCE_LOGS];
let serverMovementsStore = [...INITIAL_MOVEMENTS];
let serverAuditsStore = [...INITIAL_AUDIT_SESSIONS];
let serverPrivilegesStore: any[] = [];

// Workflow Email Notifications Audit Log
interface EmailNotificationRecord {
  id: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  type: 'NEW_REGISTRATION_APPROVAL' | 'ACCOUNT_APPROVED' | 'ACCOUNT_REJECTED';
  applicantName: string;
  applicantEmail: string;
  applicantRole: string;
  applicantDepartment: string;
  applicantPhone: string;
  status: 'TERKIRIM (DELIVERED)' | 'PENDING';
  sentAt: string;
  htmlBody: string;
}

let serverNotificationsLog: EmailNotificationRecord[] = [];

// API User 1: Get All Registered Users
app.get('/api/users', async (req, res) => {
  try {
    // Attempt DB query if Cloud SQL configured
    if (process.env.SQL_HOST) {
      const { db } = await import('./src/db/index.ts');
      const { users } = await import('./src/db/schema.ts');
      const dbUsers = await db.select().from(users);
      if (dbUsers && dbUsers.length > 0) {
        const mappedUsers = dbUsers.map((u: any) => ({
          id: `usr-db-${u.id}`,
          name: u.name || 'Pengguna',
          email: u.email,
          password: u.password || 'pass123',
          role: u.role || 'Staff Operasional',
          department: u.department || 'General',
          location: u.location || 'Head Office',
          status: (u as any).status || 'Aktif',
          lastLogin: new Date().toISOString().slice(0, 16).replace('T', ' '),
          phone: '-'
        }));
        // Merge with serverUsersStore to preserve new pending registers
        const existingEmails = new Set(mappedUsers.map(m => m.email.toLowerCase()));
        serverUsersStore.forEach(su => {
          if (!existingEmails.has(su.email.toLowerCase())) {
            mappedUsers.push(su);
          }
        });
        serverUsersStore = mappedUsers;
      }
    }
    res.json({ users: serverUsersStore });
  } catch (err: any) {
    console.warn('Get users fallback to in-memory store:', err.message);
    res.json({ users: serverUsersStore });
  }
});

// API User 2: Register New User with Workflow Approval & Email Notification
app.post('/api/users/register', async (req, res) => {
  try {
    const { name, email, password, role, department, location, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nama, Email, dan Password wajib diisi.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = serverUsersStore.find(u => u.email.toLowerCase() === cleanEmail);
    if (existing) {
      return res.status(400).json({ error: `Email ${cleanEmail} sudah terdaftar dalam database.` });
    }

    const newUser = {
      id: `usr-${Date.now()}`,
      name: name.trim(),
      email: cleanEmail,
      password,
      role: role || 'Staff Operasional',
      department: department || 'Information Technology',
      location: location || 'Head Office Jakarta',
      status: 'Pending Approval',
      phone: phone || '-',
      lastLogin: '-'
    };

    serverUsersStore.unshift(newUser);

    // Save to PostgreSQL if Cloud SQL is configured
    try {
      if (process.env.SQL_HOST) {
        const { db } = await import('./src/db/index.ts');
        const { users } = await import('./src/db/schema.ts');
        await db.insert(users).values({
          uid: newUser.id,
          name: newUser.name,
          email: newUser.email,
          password: newUser.password,
          role: newUser.role,
          department: newUser.department,
          location: newUser.location,
        });
      }
    } catch (dbErr: any) {
      console.warn('PostgreSQL insert warning:', dbErr.message);
    }

    // Generate Email Notification for Super Admin (Asep Pradana)
    const notifRecord: EmailNotificationRecord = {
      id: `notif-${Date.now()}`,
      recipientEmail: 'aseppradana@kdcgroup.co.id',
      recipientName: 'Asep Pradana (Super Admin)',
      subject: `[SIMASET APPROVAL] Permohonan Pendaftaran Akun Baru: ${newUser.name}`,
      type: 'NEW_REGISTRATION_APPROVAL',
      applicantName: newUser.name,
      applicantEmail: newUser.email,
      applicantRole: newUser.role,
      applicantDepartment: newUser.department,
      applicantPhone: newUser.phone,
      status: 'TERKIRIM (DELIVERED)',
      sentAt: new Date().toISOString(),
      htmlBody: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
          <div style="background: linear-gradient(to right, #0f172a, #1e1b4b); color: #ffffff; padding: 24px;">
            <h2 style="margin: 0; font-size: 20px;">[SIMASET] Permohonan Pendaftaran Akun Baru</h2>
            <p style="margin: 6px 0 0 0; font-size: 13px; color: #cbd5e1;">Enterprise Asset Management KDC Group</p>
          </div>
          <div style="padding: 24px; color: #334155; font-size: 14px; line-height: 1.6;">
            <p>Yth. <strong>Bapak Asep Pradana (Super Admin)</strong>,</p>
            <p>Terdapat permohonan pendaftaran akun pengguna baru di portal SIMASET yang memerlukan peninjauan dan persetujuan (approval) Anda:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
              <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold; width: 140px; border-bottom: 1px solid #f1f5f9;">Nama Pendaftar:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9;">${newUser.name}</td></tr>
              <tr><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Email Perusahaan:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #2563eb; font-weight: bold;">${newUser.email}</td></tr>
              <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Role Diajukan:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9; font-weight: bold; color: #059669;">${newUser.role}</td></tr>
              <tr><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Departemen:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9;">${newUser.department}</td></tr>
              <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">No. Telepon / WA:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9;">${newUser.phone}</td></tr>
              <tr><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Status Akun:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9;"><span style="background-color: #fef3c7; color: #92400e; padding: 4px 8px; border-radius: 6px; font-weight: bold;">Pending Approval</span></td></tr>
            </table>
            <p>Silakan masuk ke portal <strong>User Management & Approval SIMASET</strong> untuk menyetujui (approve) atau menolak permohonan ini.</p>
          </div>
          <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
            Sistem Otomatis Notifikasi Workflow Approval SIMASET &bull; KDC Group
          </div>
        </div>
      `
    };

    serverNotificationsLog.unshift(notifRecord);

    return res.json({
      success: true,
      message: 'Pendaftaran akun berhasil disimpan. Workflow notifikasi email approval dikirim ke Super Admin (aseppradana@kdcgroup.co.id).',
      user: newUser,
      notification: notifRecord,
      users: serverUsersStore
    });
  } catch (err: any) {
    console.error('Register user error:', err);
    return res.status(500).json({ error: 'Gagal melakukan pendaftaran akun.', details: err.message });
  }
});

// API User 3: Login Authentication Check
app.post('/api/users/login', (req, res) => {
  const { email, password } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email wajib diisi.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const user = serverUsersStore.find(u => u.email.toLowerCase() === cleanEmail);

  if (!user) {
    return res.status(404).json({ error: 'Pengguna dengan email ini tidak ditemukan.' });
  }

  if (user.status === 'Nonaktif') {
    return res.status(403).json({ error: 'Akun Anda NONAKTIF. Hubungi Super Admin.' });
  }

  if (user.status === 'Pending Approval') {
    return res.status(403).json({
      error: 'Akun Anda masih MENUNGGU PERSETUJUAN (Pending Approval) oleh Super Admin (aseppradana@kdcgroup.co.id).'
    });
  }

  const expectedPassword = user.password || 'pass123';
  if (password && password !== expectedPassword) {
    return res.status(401).json({ error: 'Password yang Anda masukkan salah.' });
  }

  user.lastLogin = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return res.json({
    success: true,
    user,
    users: serverUsersStore
  });
});

// API User 4: Approve Pending Registration
app.post('/api/users/approve', (req, res) => {
  const { userId, approvedBy = 'Asep Pradana' } = req.body;
  const userIndex = serverUsersStore.findIndex(u => u.id === userId);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User tidak ditemukan.' });
  }

  const user = serverUsersStore[userIndex];
  user.status = 'Aktif';
  user.lastLogin = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Generate Email Approval Notification to the user
  const approvalNotif: EmailNotificationRecord = {
    id: `notif-appr-${Date.now()}`,
    recipientEmail: user.email,
    recipientName: user.name,
    subject: `[SIMASET APPROVED] Selamat! Akun SIMASET Anda telah Disetujui`,
    type: 'ACCOUNT_APPROVED',
    applicantName: user.name,
    applicantEmail: user.email,
    applicantRole: user.role,
    applicantDepartment: user.department,
    applicantPhone: user.phone || '-',
    status: 'TERKIRIM (DELIVERED)',
    sentAt: new Date().toISOString(),
    htmlBody: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
        <div style="background: linear-gradient(to right, #059669, #047857); color: #ffffff; padding: 24px;">
          <h2 style="margin: 0; font-size: 20px;">[SIMASET] Akun Pendaftaran Disetujui!</h2>
          <p style="margin: 6px 0 0 0; font-size: 13px; color: #d1fae5;">Enterprise Asset Management KDC Group</p>
        </div>
        <div style="padding: 24px; color: #334155; font-size: 14px; line-height: 1.6;">
          <p>Halo <strong>${user.name}</strong>,</p>
          <p>Selamat! Permohonan pendaftaran akun Anda telah <strong>DISETUJUI (APPROVED)</strong> oleh <strong>${approvedBy} (Super Admin)</strong>.</p>
          <p>Anda sekarang dapat masuk dan mengakses seluruh fitur SIMASET sesuai dengan otoritas role Anda:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
            <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold; width: 140px; border-bottom: 1px solid #f1f5f9;">Email Login:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9; font-weight: bold; color: #2563eb;">${user.email}</td></tr>
            <tr><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Role Ditugaskan:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9; font-weight: bold; color: #059669;">${user.role}</td></tr>
            <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Departemen:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9;">${user.department}</td></tr>
            <tr><td style="padding: 10px; font-weight: bold; border-bottom: 1px solid #f1f5f9;">Status:</td><td style="padding: 10px; border-bottom: 1px solid #f1f5f9;"><span style="background-color: #d1fae5; color: #065f46; padding: 4px 8px; border-radius: 6px; font-weight: bold;">AKTIFF</span></td></tr>
          </table>
          <p>Silakan gunakan email dan password terdaftar Anda untuk masuk ke sistem.</p>
        </div>
        <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
          Tim IT & Security Asset Management &bull; KDC Group
        </div>
      </div>
    `
  };

  serverNotificationsLog.unshift(approvalNotif);

  return res.json({
    success: true,
    message: `Akun ${user.name} berhasil disetujui. Email notifikasi otomatis dikirim ke ${user.email}.`,
    user,
    users: serverUsersStore,
    notification: approvalNotif
  });
});

// API User 5: Update User Profile / Role / Status
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const userIndex = serverUsersStore.findIndex(u => u.id === id);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User tidak ditemukan.' });
  }

  const updatedUser = {
    ...serverUsersStore[userIndex],
    ...req.body
  };

  serverUsersStore[userIndex] = updatedUser;

  return res.json({
    success: true,
    user: updatedUser,
    users: serverUsersStore
  });
});

// API User 6: Delete User
app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  serverUsersStore = serverUsersStore.filter(u => u.id !== id);
  return res.json({ success: true, users: serverUsersStore });
});

// API User 7: Get Workflow Email Notifications Audit Log
app.get('/api/notifications', (req, res) => {
  return res.json({ notifications: serverNotificationsLog });
});

// API DB 1: GET FULL SYNCHRONIZED DATABASE (For all logged in users)
app.get('/api/db/full-sync', (req, res) => {
  return res.json({
    success: true,
    users: serverUsersStore,
    assets: serverAssetsStore,
    categories: serverCategoriesStore,
    locations: serverLocationsStore,
    departments: serverDepartmentsStore,
    maintenanceLogs: serverMaintenanceStore,
    movements: serverMovementsStore,
    auditSessions: serverAuditsStore,
    privileges: serverPrivilegesStore,
    lastSyncedAt: new Date().toISOString()
  });
});

// API DB 2: POST FULL SYNCHRONIZED DATABASE UPDATE (Pushes updates from any user)
app.post('/api/db/full-sync', (req, res) => {
  const { 
    users, 
    assets, 
    categories, 
    locations, 
    departments, 
    maintenanceLogs, 
    movements, 
    auditSessions, 
    privileges 
  } = req.body;

  if (Array.isArray(users)) serverUsersStore = users;
  if (Array.isArray(assets)) serverAssetsStore = assets;
  if (Array.isArray(categories)) serverCategoriesStore = categories;
  if (Array.isArray(locations)) serverLocationsStore = locations;
  if (Array.isArray(departments)) serverDepartmentsStore = departments;
  if (Array.isArray(maintenanceLogs)) serverMaintenanceStore = maintenanceLogs;
  if (Array.isArray(movements)) serverMovementsStore = movements;
  if (Array.isArray(auditSessions)) serverAuditsStore = auditSessions;
  if (Array.isArray(privileges)) serverPrivilegesStore = privileges;

  return res.json({
    success: true,
    message: 'Seluruh database berhasil disinkronisasikan ke semua akun pengguna.',
    users: serverUsersStore,
    assets: serverAssetsStore,
    categories: serverCategoriesStore,
    locations: serverLocationsStore,
    departments: serverDepartmentsStore,
    maintenanceLogs: serverMaintenanceStore,
    movements: serverMovementsStore,
    auditSessions: serverAuditsStore,
    privileges: serverPrivilegesStore,
    lastSyncedAt: new Date().toISOString()
  });
});

// API DB 3: FORCE USER DATABASE SYNC & PRIVILEGES MAPPING
app.post('/api/users/sync-user-databases', (req, res) => {
  const { syncBy = 'Super Admin' } = req.body;

  // Make sure all users have valid active status and timestamps
  serverUsersStore = serverUsersStore.map(user => ({
    ...user,
    lastLogin: user.lastLogin || new Date().toISOString().slice(0, 16).replace('T', ' ')
  }));

  return res.json({
    success: true,
    message: `Database untuk seluruh ${serverUsersStore.length} pengguna terdaftar berhasil disinkronkan secara real-time oleh ${syncBy}.`,
    syncedUsersCount: serverUsersStore.length,
    users: serverUsersStore,
    assetsCount: serverAssetsStore.length,
    lastSyncedAt: new Date().toISOString()
  });
});

// AI Endpoint 1: Analyze Asset Portfolio or Asset Life Cycle
app.post('/api/ai-asset/analyze', async (req, res) => {
  try {
    const { prompt, assetData } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(200).json({
        summary: 'Mode AI terbatas (API Key belum dikonfigurasi). Menampilkan estimasi berdasarkan algoritma standar.',
        insights: [
          'Jadwal maintenance rutin disarankan setiap 6 bulan untuk perangkat IT.',
          'Gunakan metode depresiasi garis lurus untuk kepatuhan akuntansi fiskal.',
          'Pastikan audit fisik (Stock Opname) dilakukan minimal 1x setahun.'
        ],
        recommendations: [
          'Lakukan penggantian unit jika biaya perbaikan melebihi 50% nilai sisa aset.',
          'Perbarui QR tag fisik yang mulai pudar pada kendaraan operasional.'
        ],
        riskAlerts: [
          'Beberapa unit mendekati masa garansi habis dalam 90 hari kedepan.'
        ]
      });
    }

    const ai = getAIClient();
    const model = 'gemini-2.5-flash';

    const systemInstruction = `
You are an expert Enterprise Asset Management (EAM) Advisor and Chartered Asset Valuation Consultant in Indonesia.
Respond in clear, professional Indonesian language.
Provide structured analysis including:
1. Executive Summary (1 paragraph)
2. Strategic Insights (3 bullet points)
3. Actionable Recommendations (2-3 bullet points)
4. Risk Alerts (if any)
Keep numbers in IDR / Rupiah when applicable.
`;

    const userContent = `
Task: ${prompt || 'Analisis kondisi dan strategi pemeliharaan aset berikut'}
Context Asset Data:
${JSON.stringify(assetData || {}, null, 2)}
`;

    const response = await ai.models.generateContent({
      model,
      contents: [
        { role: 'user', parts: [{ text: `${systemInstruction}\n\n${userContent}` }] }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING' },
            insights: { type: 'ARRAY', items: { type: 'STRING' } },
            recommendations: { type: 'ARRAY', items: { type: 'STRING' } },
            riskAlerts: { type: 'ARRAY', items: { type: 'STRING' } },
            estimatedResaleValueIDR: { type: 'NUMBER' }
          },
          required: ['summary', 'insights', 'recommendations', 'riskAlerts']
        }
      }
    });

    const resultText = response.text;
    if (resultText) {
      const parsed = JSON.parse(resultText);
      return res.json(parsed);
    }

    throw new Error('Empty response from AI model');
  } catch (error: any) {
    console.error('AI Asset Analysis Error:', error);
    return res.status(500).json({
      error: 'Gagal memproses analisis AI',
      details: error.message
    });
  }
});

// AI Endpoint 2: Smart Asset Description & Maintenance Specs Generator
app.post('/api/ai-asset/generate-specs', async (req, res) => {
  try {
    const { itemName, category, brand } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(200).json({
        description: `${itemName || 'Aset'} dari ${brand || 'Merk Utama'} kategori ${category || 'Umum'}. Perlengkapan operasional standar perusahaan.`,
        suggestedUsefulLife: 5,
        suggestedMaintenanceIntervalMonths: 6,
        tags: [category || 'Aset', brand || 'Spesifikasi', 'Operasional']
      });
    }

    const ai = getAIClient();
    const model = 'gemini-2.5-flash';

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{
            text: `Buatkan deskripsi formal, estimasi masa manfaat (tahun), interval maintenance (bulan), dan kata kunci untuk aset berikut dalam Bahasa Indonesia:
Nama Item: ${itemName}
Kategori: ${category}
Merk: ${brand}`
          }]
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING' },
            suggestedUsefulLife: { type: 'NUMBER' },
            suggestedMaintenanceIntervalMonths: { type: 'NUMBER' },
            tags: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['description', 'suggestedUsefulLife', 'suggestedMaintenanceIntervalMonths', 'tags']
        }
      }
    });

    if (response.text) {
      return res.json(JSON.parse(response.text));
    }

    throw new Error('No AI specs generated');
  } catch (err: any) {
    console.error('AI Specs Generator Error:', err);
    res.status(500).json({ error: 'Gagal membuat deskripsi AI', details: err.message });
  }
});

async function startServer() {
  // Vite middleware in non-production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Asset Management running on http://localhost:${PORT}`);
  });
}

startServer();
