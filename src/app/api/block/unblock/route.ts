import { NextResponse } from 'next/server'
import { sshConnection } from '@/app/lib/ssh'

export async function POST(request: Request) {
  try {
    const { ip } = await request.json();

    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return NextResponse.json({ success: false, message: '❌ Alamat IP tidak valid' }, { status: 400 });
    }

    console.log(`🔓 Attempting to unblock IP: ${ip}`);

    let unblocked = false;
    let errorDetails = '';

    // ========== Call wrapper script with --remove flag ==========
    try {
      console.log('🔧 Calling wrapper script to unblock IP...');
      
      // Call: /usr/local/sbin/block_ip.sh --remove <ip>
      const scriptOutput = await sshConnection.execSudo(`/usr/local/sbin/block_ip.sh --remove ${ip}`);
      
      if (String(scriptOutput || '').includes('[+]') || String(scriptOutput || '').includes('Successfully')) {
        unblocked = true;
        console.log(`✅ IP ${ip} unblocked via wrapper script`);
        console.log('Script output:', scriptOutput);
      } else {
        throw new Error(String(scriptOutput || 'Script returned no success marker'));
      }
    } catch (scriptError: any) {
      console.log('⚠️ Wrapper script failed:', scriptError.message);
      errorDetails = scriptError.message || String(scriptError);
    }

    // ========== Remove from Firebase blocks ==========
    try {
      const { db } = await import('@/app/lib/firebase');
      const { ref, get, remove } = await import('firebase/database');

      const blocksRef = ref(db, 'blocks');
      const snap = await get(blocksRef);
      if (snap.exists()) {
        const data = snap.val();
        for (const key of Object.keys(data)) {
          const b = data[key];
          if (b && b.ip === ip) {
            await remove(ref(db, `blocks/${key}`));
            console.log(`🗑️ Removed block entry ${key} for ${ip} from Firebase`);
          }
        }
      }
    } catch (fbErr) {
      console.log('⚠️ Firebase cleanup skipped:', fbErr.message || fbErr);
      errorDetails += `firebase: ${String(fbErr.message || fbErr)}; `;
    }

    if (unblocked) {
      return NextResponse.json({ success: true, message: `✅ IP ${ip} unblocked`, error: errorDetails || null });
    }

    return NextResponse.json({ success: false, message: `❌ Gagal membuka blokir IP ${ip}`, error: errorDetails || null }, { status: 500 });

  } catch (err: any) {
    console.error('❌ Unblock error:', err);
    return NextResponse.json({ success: false, message: '❌ Terjadi kesalahan sistem', error: String(err) }, { status: 500 });
  }
}
