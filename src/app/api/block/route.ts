import { NextResponse } from 'next/server'
import { sshConnection } from '@/app/lib/ssh'

export async function POST(request: Request) {
  try {
    const { ip } = await request.json()

    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return NextResponse.json(
        { success: false, message: '❌ Alamat IP tidak valid' },
        { status: 400 }
      )
    }

    console.log(`🚫 Attempting to block IP: ${ip}`);

    let blocked = false;
    let blockMethod = 'wrapper-script';
    let errorDetails = '';

    // ========== Call wrapper script: /usr/local/sbin/block_ip.sh ==========
    try {
      console.log('🔧 Calling wrapper script to block IP...');
      
      // Call wrapper script (requires sudoers: haikal ALL=(root) NOPASSWD: /usr/local/sbin/block_ip.sh)
      const scriptOutput = await sshConnection.execSudo(`/usr/local/sbin/block_ip.sh ${ip}`);
      
      if (String(scriptOutput || '').includes('[+]') || String(scriptOutput || '').includes('Successfully')) {
        blocked = true;
        console.log(`✅ IP ${ip} blocked via wrapper script`);
        console.log('Script output:', scriptOutput);
      } else {
        throw new Error(String(scriptOutput || 'Script returned no success marker'));
      }
    } catch (scriptError: any) {
      console.log('⚠️ Wrapper script failed:', scriptError.message);
      errorDetails = scriptError.message || String(scriptError);
    }

    // ========== LOG TO FIREBASE ==========
    try {
      const { db } = await import('@/app/lib/firebase')
      const { ref, push, get, update: dbUpdate } = await import('firebase/database')
      
      // Log block action
      await push(ref(db, 'blocks'), {
        ip: ip,
        timestamp: new Date().toISOString(),
        success: blocked,
        method: blockMethod || 'none',
        error: errorDetails || null
      })

      // Update attack records
      const attacksSnapshot = await get(ref(db, 'attacks'))
      if (attacksSnapshot.exists()) {
        const attacks = attacksSnapshot.val()
        const updates: any = {}
        
        Object.keys(attacks).forEach((key) => {
          if (attacks[key].sourceIP === ip && !attacks[key].blocked) {
            updates[`attacks/${key}/blocked`] = true
            updates[`attacks/${key}/blockedAt`] = new Date().toISOString()
            updates[`attacks/${key}/blockMethod`] = blockMethod
          }
        })
        
        if (Object.keys(updates).length > 0) {
          const { ref: dbRef, update } = await import('firebase/database')
          await update(dbRef(db), updates)
          console.log(`📝 Updated ${Object.keys(updates).length / 3} attack records`)
        }
      }
    } catch (firebaseError) {
      console.log('⚠️ Firebase logging skipped')
    }

    // ========== RESPONSE ==========
    if (blocked) {
      return NextResponse.json({ 
        success: true,
        message: `✅ IP ${ip} berhasil diblokir`,
        method: blockMethod,
        ip: ip,
        timestamp: new Date().toISOString()
      })
    } else {
      return NextResponse.json({ 
        success: false,
        message: `❌ Gagal memblokir IP ${ip}`,
        error: errorDetails,
        suggestions: [
          'Pastikan wrapper script ada di /usr/local/sbin/block_ip.sh',
          'Jalankan: sudo visudo, tambahkan: haikal ALL=(root) NOPASSWD: /usr/local/sbin/block_ip.sh',
          'Periksa apakah firewalld atau iptables terinstall',
          'Cek log dengan: sudo tail -n 50 /var/log/secure'
        ]
      }, { status: 500 })
    }

  } catch (error: any) {
    console.error('❌ Critical error:', error)
    return NextResponse.json(
      { 
        success: false,
        message: '❌ Terjadi kesalahan sistem',
        error: error.message || String(error)
      },
      { status: 500 }
    )
  }
}