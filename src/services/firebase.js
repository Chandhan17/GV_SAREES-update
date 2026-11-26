import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const db = getFirestore(app)

if (import.meta.env.MODE === 'performance') {
  const projectId = 'demo-gv-sarees'
  const firestoreHost = import.meta.env.VITE_FIRESTORE_EMULATOR_HOST
  const authHost = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST

  if (firebaseConfig.projectId !== projectId ||
      firestoreHost !== '127.0.0.1:8080' ||
      authHost !== '127.0.0.1:9099') {
    throw new Error('Performance Firebase configuration is not isolated to the local Emulator.')
  }

  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
}
