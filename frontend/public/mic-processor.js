/**
 * Downsampler AudioWorklet with adaptive timing-based VAD.
 * Captures at native rate (48kHz), downsamples to 16kHz via linear interpolation,
 * converts to Int16 PCM. Uses adaptive threshold + minimum durations.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._targetRate = 16000
    this._factor = sampleRate / this._targetRate
    this._phase = 0

    // Adaptive VAD
    this._ambientRms = 0.01      // Start low — calibrates up from real ambient
    this._calibrationFrames = 0  // Count frames for initial calibration
    this._calibrationDelay = 40  // Skip first ~10s (greeting plays through speakers)
    this._minThreshold = 0.03    // Very low floor for Cloud Run / distance
    this._thresholdMultiplier = 2.0 // Speech must be 2x ambient

    // Timing
    this._minSpeechMs = 150      // Must be above threshold for 150ms to start
    this._minSilenceMs = 1200    // Must be below for 1.2s to end
    this._cooldownMs = 400       // Min gap between transitions

    // State
    this._isSpeaking = false
    this._speechStartTime = 0
    this._silenceStartTime = 0
    this._lastTransitionTime = 0

    // Buffer
    this._buffer = []
    this._bufferTarget = 4096

    this.port.postMessage({
      type: 'info',
      sampleRate: sampleRate,
      targetRate: this._targetRate,
      factor: this._factor
    })
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true
    const channel = input[0]

    // Downsample: linear interpolation from native rate to 16kHz
    while (this._phase < channel.length) {
      const idx = Math.floor(this._phase)
      const frac = this._phase - idx
      const s0 = channel[idx] || 0
      const s1 = channel[Math.min(idx + 1, channel.length - 1)] || s0
      this._buffer.push(s0 + frac * (s1 - s0))
      this._phase += this._factor
    }
    this._phase -= channel.length

    while (this._buffer.length >= this._bufferTarget) {
      const chunk = this._buffer.splice(0, this._bufferTarget)
      const nowMs = currentTime * 1000

      // Compute RMS
      let rms = 0
      for (let i = 0; i < chunk.length; i++) rms += chunk[i] * chunk[i]
      rms = Math.sqrt(rms / chunk.length)

      // Adaptive threshold: track ambient noise level
      // Skip first ~10s (greeting plays through speakers — would corrupt calibration)
      if (this._calibrationFrames < this._calibrationDelay) {
        this._calibrationFrames++
      } else if (this._calibrationFrames < this._calibrationDelay + 20) {
        // Calibrate from frames AFTER greeting finishes
        const calibIdx = this._calibrationFrames - this._calibrationDelay
        this._ambientRms = calibIdx === 0 ? rms : this._ambientRms * 0.8 + rms * 0.2
        this._calibrationFrames++
      } else if (!this._isSpeaking) {
        // Update ambient only when not speaking (slow decay)
        this._ambientRms = this._ambientRms * 0.95 + rms * 0.05
      }

      // Dynamic threshold: ambient * multiplier, with absolute floor
      const speechThreshold = Math.max(this._minThreshold, this._ambientRms * this._thresholdMultiplier)
      const silenceThreshold = Math.max(this._minThreshold * 0.5, this._ambientRms * 1.5)

      const wasSpeaking = this._isSpeaking
      const timeSinceTransition = nowMs - this._lastTransitionTime

      if (!this._isSpeaking) {
        if (rms > speechThreshold) {
          if (this._speechStartTime === 0) this._speechStartTime = nowMs
          if ((nowMs - this._speechStartTime) >= this._minSpeechMs && timeSinceTransition >= this._cooldownMs) {
            this._isSpeaking = true
            this._silenceStartTime = 0
            this._lastTransitionTime = nowMs
          }
        } else {
          this._speechStartTime = 0
        }
      } else {
        if (rms < silenceThreshold) {
          if (this._silenceStartTime === 0) this._silenceStartTime = nowMs
          if ((nowMs - this._silenceStartTime) >= this._minSilenceMs && timeSinceTransition >= this._cooldownMs) {
            this._isSpeaking = false
            this._speechStartTime = 0
            this._lastTransitionTime = nowMs
          }
        } else {
          this._silenceStartTime = 0
        }
      }

      // VAD transition events — include threshold info for debugging
      if (!wasSpeaking && this._isSpeaking) {
        this.port.postMessage({ type: 'vad', speaking: true, rms, threshold: speechThreshold })
      }
      if (wasSpeaking && !this._isSpeaking) {
        this.port.postMessage({ type: 'vad', speaking: false, rms, threshold: silenceThreshold })
      }

      // Send audio during speech + silence-wait tail
      if (this._isSpeaking || this._silenceStartTime > 0) {
        const int16 = new Int16Array(chunk.length)
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]))
          int16[i] = s < 0 ? s * 32768 : s * 32767
        }
        this.port.postMessage({ type: 'audio', data: int16.buffer }, [int16.buffer])
      }
    }

    return true
  }
}

registerProcessor('mic-processor', MicProcessor)
