import {
  PERFORMANCE_PROJECT_ID,
  PERFORMANCE_API_RUNTIME_HEADER,
  assertServerPerformanceConfiguration,
  getPerformanceApiRuntimeIdentity,
  verifyFirestoreEmulator,
} from '../server/performanceSafety.js'

export default function handler(req, res) {
  if (process.env.APP_MODE === 'performance' || process.env.TELEGRAM_TEST_MODE === '1') {
    const runtimeIdentity = getPerformanceApiRuntimeIdentity()
    if (runtimeIdentity) {
      res.setHeader(PERFORMANCE_API_RUNTIME_HEADER, runtimeIdentity)
    }
    void verifyPerformanceEnvironment(res)
    return
  }

  res.status(200).json({
    success: true,
    message: "API route working"
  });
}

async function verifyPerformanceEnvironment(res) {
  try {
    assertServerPerformanceConfiguration()
    await verifyFirestoreEmulator({
      projectId: process.env.FIREBASE_PROJECT_ID,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    })
    return res.status(200).json({
      success: true,
      performanceMode: true,
      projectId: PERFORMANCE_PROJECT_ID,
      emulatorVerified: true,
    })
  } catch {
    return res.status(503).json({
      success: false,
      performanceMode: false,
      emulatorVerified: false,
      message: 'Performance environment safety checks failed.',
    })
  }
}