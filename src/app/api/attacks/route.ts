import { NextResponse } from 'next/server'
import { sshConnection } from '@/app/lib/ssh'

interface SuricataAlert {
  timestamp: string;
  src_ip: string;
  src_port: number;
  dest_ip: string;
  dest_port: number;
  proto: string;
  alert: {
    signature: string;
    severity: number;
    signature_id: number;
  };
  event_type: string;
}

// 🔥 FIX: Track processed alerts dengan signature unik (TTL-based)
const processedAlerts = new Map<string, number>();
const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const IGNORE_PRIVATE_IPS = false; // set true untuk menyembunyikan IP private/internal

function isPrivateIP(ip: string) {
  return /^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip);
}

function cleanProcessedAlerts() {
  const now = Date.now();
  for (const [key, ts] of processedAlerts.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) processedAlerts.delete(key);
  }
}

function isRecentlyProcessed(signature: string, timestampMs?: number) {
  cleanProcessedAlerts();
  if (processedAlerts.has(signature)) return true;
  processedAlerts.set(signature, timestampMs || Date.now());
  return false;
}
let lastProcessedTimestamp: string | null = null;

// Helper: exec dengan timeout karena `sshConnection.exec` tidak menerima opsi timeout
async function execWithTimeout(command: string, ms: number): Promise<string> {
  return await Promise.race([
    sshConnection.exec(command),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('SSH exec timeout')), ms))
  ]);
}

function parseSuricataLog(line: string): SuricataAlert | null {
  try {
    const log = JSON.parse(line);
    if (log.event_type === 'alert') {
      return log;
    }
  } catch (e) {
    // Skip invalid lines
  }
  return null;
}

function mapSeverity(severity: number): 'rendah' | 'sedang' | 'tinggi' | 'kritis' {
  if (severity === 1) return 'kritis';
  if (severity === 2) return 'tinggi';
  if (severity === 3) return 'sedang';
  return 'rendah';
}

function mapAttackType(signature: string): string {
  const sig = signature.toLowerCase();
  
  if (sig.includes('ddos') || sig.includes('flood')) return 'DDoS';
  if (sig.includes('brute') || sig.includes('brute-force')) return 'Brute Force';
  // treat SSH-related signatures as brute only when they mention failed/login/attempt/auth
  if (sig.includes('ssh') || sig.includes('sshd')) {
    if (sig.includes('failed') || sig.includes('login') || sig.includes('attempt') || sig.includes('auth') || sig.includes('authentication')) {
      return 'Brute Force';
    }
  }
  if (sig.includes('sql')) return 'SQL Injection';
  if (sig.includes('scan')) return 'Port Scanning';
  if (sig.includes('xss')) return 'XSS Attack';
  if (sig.includes('malware')) return 'Malware';
  
  return 'Unknown Attack';
}

export async function GET(request: Request) {
  try {
    let attacks: any[] = [];
    let dataSource = 'none';

    const { searchParams } = new URL(request.url);
    const reset = searchParams.get('reset') === 'true';

    // Reset sistem
    if (reset) {
      processedAlerts.clear();
      lastProcessedTimestamp = new Date().toISOString();
      console.log(`🔄 RESET: Starting fresh from ${lastProcessedTimestamp}`);
      
      return NextResponse.json({
        attacks: [],
        stats: { totalAttacks: 0, blockedIPs: 0, activeThreats: 0, threatsBlocked: 0 },
        source: 'suricata',
        timestamp: new Date().toISOString(),
        message: 'System reset successfully'
      });
    }

    // Initialize timestamp pertama kali
    if (!lastProcessedTimestamp) {
      lastProcessedTimestamp = new Date().toISOString();
      console.log(`🚀 INIT: Starting monitoring from ${lastProcessedTimestamp}`);
    }

    // ========== 1. COBA SURICATA (REAL-TIME) ==========
    try {
      console.log('🔌 Connecting to CentOS Suricata...');
      
      // 🔥 FIX: Test connection dengan timeout pendek
      const connectionTest = await Promise.race([
        sshConnection.testConnection(),
        new Promise<boolean>((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 5000)
        )
      ]);

      if (!connectionTest) {
        throw new Error('SSH connection test failed');
      }

      // 🔥 CRITICAL: Baca log Suricata dengan timeout dan pemeriksaan aman
      const checkCmd = `test -f /var/log/suricata/eve.json && echo "exists" || echo "not found"`;
      const fileCheckRaw = await execWithTimeout(checkCmd, 3000);
      const fileCheck = String(fileCheckRaw || '');

      if (!fileCheck.includes('exists')) {
        throw new Error('Suricata log file not found');
      }

      // Baca 50 baris terakhir dengan timeout
      const tailCommand = 'tail -n 50 /var/log/suricata/eve.json';
      const logContentRaw = await execWithTimeout(tailCommand, 8000);
      const logContent = String(logContentRaw || '');
      
      const lines = logContent.split('\n').filter(line => line.trim());
      console.log(`📄 Read ${lines.length} lines from Suricata log`);

      // Parse semua alert dulu, simpan raw line juga
      const parsedLines: Array<{ alert: SuricataAlert; raw: string }> = [];
      for (const line of lines) {
        const alert = parseSuricataLog(line);
        if (alert) parsedLines.push({ alert, raw: line });
      }

      // Hitung kemunculan per src+signature untuk mendeteksi brute/scan
      const occurrence = new Map<string, number>();
      for (const p of parsedLines) {
        const key = `${p.alert.src_ip}-${p.alert.alert.signature_id}`;
        occurrence.set(key, (occurrence.get(key) || 0) + 1);
      }

      // Tentukan apakah batch ini mengandung serangan nyata
      const attackCandidates = parsedLines.filter((p) => {
        const a = p.alert;
        const key = `${a.src_ip}-${a.alert.signature_id}`;
        const count = occurrence.get(key) || 0;
        const type = mapAttackType(a.alert.signature);

        // Rules: treat as attack if
        // - signature maps to known attack type (not Unknown) AND (severity <= 2 (kritis/tinggi) OR repeated >=3 times)
        // - OR severity is kritis (1)
        if (type !== 'Unknown Attack') {
          // Treat severity 1-3 as relevant (kritis/tinggi/sedang)
          if (a.alert.severity <= 3) return true;
          if (count >= 3) return true;
        }
        if (a.alert.severity === 1) return true;
        return false;
      });

      if (attackCandidates.length > 0) {
        console.log(`🔥 Detected ${attackCandidates.length} attack candidate(s) in recent logs`);

        for (const p of attackCandidates) {
          const alert = p.alert;
          const alertTime = new Date(alert.timestamp);
          const lastTime = new Date(lastProcessedTimestamp || 0);

          if (alertTime > lastTime) {
            const alertTimeMs = alertTime.getTime();
            const dedupeKey = `${alert.src_ip}-${alert.alert.signature_id}-${Math.floor((isNaN(alertTimeMs) ? Date.now() : alertTimeMs) / DEDUPE_WINDOW_MS)}`;

            // Optionally ignore private/internal IPs
            if (IGNORE_PRIVATE_IPS && isPrivateIP(alert.src_ip)) {
              continue;
            }

            if (isRecentlyProcessed(dedupeKey, isNaN(alertTimeMs) ? Date.now() : alertTimeMs)) {
              continue;
            }

            attacks.push({
              id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: alert.timestamp,
              sourceIP: alert.src_ip,
              type: mapAttackType(alert.alert.signature),
              severity: mapSeverity(alert.alert.severity),
              blocked: false,
              targetPort: alert.dest_port,
              protocol: alert.proto?.toUpperCase() || 'TCP',
              signature: alert.alert.signature,
              raw: p.raw
            });
          }
        }
      } else {
        console.log('✓ No attack candidates in recent logs — returning empty list');
      }

      // Update timestamp jika ada serangan baru
      if (attacks.length > 0) {
        const latestAttack = attacks.reduce((latest, current) => 
          new Date(current.timestamp) > new Date(latest.timestamp) ? current : latest
        );
        lastProcessedTimestamp = latestAttack.timestamp;
        
        console.log(`✅ Found ${attacks.length} NEW attacks (last: ${lastProcessedTimestamp})`);
        
        // Simpan ke Firebase untuk backup
        try {
          const { db } = await import('@/app/lib/firebase');
          const { ref, push } = await import('firebase/database');
          
          for (const attack of attacks) {
            await push(ref(db, 'attacks'), attack);
          }
          console.log(`📝 Saved to Firebase`);
        } catch (fbError) {
          console.log('⚠️ Firebase save skipped');
        }
      } else {
        console.log('✓ No new attacks detected');
      }

      dataSource = 'suricata';

    } catch (sshError: any) {
      console.log('⚠️ Suricata unavailable:', sshError.message);
      
      // ========== 2. FALLBACK KE FIREBASE ==========
      try {
        const { db } = await import('@/app/lib/firebase');
        const { ref, get, query, limitToLast, orderByKey } = await import('firebase/database');
        
        const attacksRef = ref(db, 'attacks');
        const limitedQuery = query(attacksRef, orderByKey(), limitToLast(10));
        const snapshot = await get(limitedQuery);
        
        if (snapshot.exists()) {
          const data = snapshot.val();
          attacks = Object.keys(data).map(key => ({
            id: key,
            ...data[key]
          }));
          dataSource = 'firebase';
          console.log(`✅ Loaded ${attacks.length} attacks from Firebase`);
        }
      } catch (firebaseError) {
        console.log('⚠️ Firebase also unavailable');
        dataSource = 'error';
      }
    }

    // Sort newest first
    attacks.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Merge block info from Firebase (so UI reflects blocks done via API)
    try {
      const { db } = await import('@/app/lib/firebase');
      const { ref, get, query, limitToLast, orderByKey } = await import('firebase/database');

      const blocksRef = ref(db, 'blocks');
      const blocksQuery = query(blocksRef, orderByKey(), limitToLast(200));
      const blocksSnap = await get(blocksQuery);
      if (blocksSnap.exists()) {
        const blocksData = blocksSnap.val();
        // Build map of latest block per IP
        const latestBlockByIP: Record<string, { timestamp: string; method?: string }> = {};
        Object.keys(blocksData).forEach((k) => {
          const b = blocksData[k];
          if (!b || !b.ip) return;
          const prev = latestBlockByIP[b.ip];
          if (!prev || new Date(b.timestamp) > new Date(prev.timestamp)) {
            latestBlockByIP[b.ip] = { timestamp: b.timestamp, method: b.method };
          }
        });

        // Apply to attacks list
        attacks = attacks.map((at) => {
          const ip = at.sourceIP;
          if (ip && latestBlockByIP[ip]) {
            return { ...at, blocked: true, blockedAt: latestBlockByIP[ip].timestamp, blockMethod: latestBlockByIP[ip].method || 'api' };
          }
          return at;
        });
        dataSource = dataSource || 'suricata+firebase';
      }
    } catch (mergeErr) {
      // If firebase unavailable, ignore - we still return suricata data
    }

    // Calculate stats
    const stats = {
      totalAttacks: attacks.length,
      blockedIPs: attacks.filter(a => a.blocked).length,
      activeThreats: attacks.filter(a => !a.blocked).length,
      threatsBlocked: attacks.filter(a => a.blocked).length
    };

    // No-cache headers
    const response = NextResponse.json({
      attacks: attacks,
      stats,
      source: dataSource,
      timestamp: new Date().toISOString(),
      lastProcessed: lastProcessedTimestamp,
      processedCount: processedAlerts.size
    });

    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
    
    return response;

  } catch (error) {
    console.error('❌ API Error:', error);
    
    return NextResponse.json({
      attacks: [],
      stats: { totalAttacks: 0, blockedIPs: 0, activeThreats: 0, threatsBlocked: 0 },
      source: 'error',
      error: String(error),
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}

// npx tsc --noEmit