import { NextResponse } from 'next/server'
import { sshConnection } from '@/app/lib/ssh'

/**
 * DELETE /api/clear-block?ip=<ip_address>
 * Membersihkan status "blocked" dari Firebase tanpa unblock di CentOS
 * (jika sudah dimanual unblock di CLI)
 */
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url)
    const ip = url.searchParams.get('ip')

    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return NextResponse.json(
        { success: false, message: '❌ IP address tidak valid' },
        { status: 400 }
      )
    }

    console.log(`🧹 Clearing block status for IP: ${ip}`);

    // ========== UPDATE FIREBASE: REMOVE BLOCKED STATUS ==========
    try {
      const { db } = await import('@/app/lib/firebase')
      const { ref, get, update: dbUpdate } = await import('firebase/database')
      
      // Clear attack records yang blocked untuk IP ini
      const attacksSnapshot = await get(ref(db, 'attacks'))
      if (attacksSnapshot.exists()) {
        const attacks = attacksSnapshot.val()
        const updates: any = {}
        let clearedCount = 0
        
        Object.keys(attacks).forEach((key) => {
          if (attacks[key].sourceIP === ip && attacks[key].blocked) {
            updates[`attacks/${key}/blocked`] = false
            updates[`attacks/${key}/blockedAt`] = null
            updates[`attacks/${key}/blockMethod`] = null
            clearedCount++
          }
        })
        
        if (Object.keys(updates).length > 0) {
          const { ref: dbRef, update } = await import('firebase/database')
          await dbUpdate(dbRef(db), updates)
          console.log(`✅ Cleared ${clearedCount} attack records for IP ${ip}`)
        }
      }

      return NextResponse.json({ 
        success: true,
        message: `✅ Status blocked untuk IP ${ip} sudah dihapus dari Firebase`,
        ip: ip,
        timestamp: new Date().toISOString()
      })

    } catch (firebaseError: any) {
      console.error('Firebase error:', firebaseError)
      return NextResponse.json({ 
        success: false,
        message: '❌ Gagal clear Firebase blocks',
        error: firebaseError.message
      }, { status: 500 })
    }

  } catch (error: any) {
    console.error('Unexpected error:', error)
    return NextResponse.json({ 
      success: false,
      message: '❌ Server error',
      error: error.message
    }, { status: 500 })
  }
}
