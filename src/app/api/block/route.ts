import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const { ip } = await request.json()

    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return NextResponse.json(
        { success: false, message: '❌ Alamat IP tidak valid' },
        { status: 400 }
      )
    }

    console.log(`🔔 Block request received for IP: ${ip}`);

    // Simpan request block ke Firebase sebagai record (tidak otomatis mem-block server)
    try {
      const { db } = await import('@/app/lib/firebase')
      const { ref, push } = await import('firebase/database')

      await push(ref(db, 'blocks'), {
        ip: ip,
        timestamp: new Date().toISOString(),
        success: false,
        method: 'manual-request',
        note: 'Request recorded from web UI; no remote blocking executed from server.'
      })

      return NextResponse.json({
        success: true,
        message: `ℹ️ Request to block IP ${ip} recorded. Execute block manually on server.`
      })
    } catch (fbErr: any) {
      console.error('Firebase error:', fbErr)
      return NextResponse.json({ success: false, message: '❌ Gagal mencatat ke Firebase', error: fbErr.message }, { status: 500 })
    }

  } catch (err: any) {
    console.error('Unexpected error in block route:', err)
    return NextResponse.json({ success: false, message: '❌ Server error', error: err.message }, { status: 500 })
  }
}