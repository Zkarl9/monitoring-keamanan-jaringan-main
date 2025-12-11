import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const attackData = await request.json()

    if (!attackData.sourceIP) {
      return NextResponse.json(
        { error: 'Source IP is required' },
        { status: 400 }
      )
    }

    // Coba save ke Firebase
    try {
      const { db } = await import('@/app/lib/firebase')
      const { ref, push } = await import('firebase/database')
      
      const attacksRef = ref(db, 'attacks')
      await push(attacksRef, {
        timestamp: attackData.timestamp || new Date().toISOString(),
        sourceIP: attackData.sourceIP,
        type: attackData.type || 'Unknown Attack',
        severity: attackData.severity || 'sedang',
        blocked: false,
        logEntry: attackData.logEntry,
        source: attackData.source || 'debian-server',
        protocol: 'SSH',
        targetPort: 22
      })

      console.log(`📡 Attack saved to Firebase: ${attackData.sourceIP}`)

    } catch (firebaseError) {
      console.log('Firebase save failed:', firebaseError)
      // Tetap return success meski Firebase error
    }

    return NextResponse.json({ 
      success: true, 
      message: 'Attack data recorded'
    })

  } catch (error) {
    console.error('Error saving attack data:', error)
    return NextResponse.json(
      { error: 'Failed to save attack data' },
      { status: 500 }
    )
  }
}