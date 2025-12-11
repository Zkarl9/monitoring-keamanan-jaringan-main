import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'


const firebaseConfig = {
  databaseURL: "https://monitoring-kj-default-rtdb.asia-southeast1.firebasedatabase.app"
}


const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)