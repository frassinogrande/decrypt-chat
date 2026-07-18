import type { MediaDevice, MediaConstraints } from '../types';
import { debug } from '$lib/utils/debug';

export class MediaManager {
    private localStream: MediaStream | null = null;
    private audioDevices: MediaDevice[] = [];
    private videoDevices: MediaDevice[] = [];
    private audioOutputDevices: MediaDevice[] = [];

    constructor() {
        this.initializeDevices();
    }

    async initializeDevices(): Promise<void> {
        try {
            await this.enumerateDevices();
        } catch (error) {
            debug.warn('Failed to enumerate media devices:', error);
        }
    }

    async enumerateDevices(): Promise<MediaDevice[]> {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();

            this.audioDevices = devices
                .filter((device) => device.kind === 'audioinput')
                .map((device) => ({
                    deviceId: device.deviceId,
                    label: device.label || `Microphone ${device.deviceId.slice(0, 5)}`,
                    kind: 'audioinput' as const,
                }));

            this.videoDevices = devices
                .filter((device) => device.kind === 'videoinput')
                .map((device) => ({
                    deviceId: device.deviceId,
                    label: device.label || `Camera ${device.deviceId.slice(0, 5)}`,
                    kind: 'videoinput' as const,
                }));

            this.audioOutputDevices = devices
                .filter((device) => device.kind === 'audiooutput')
                .map((device) => ({
                    deviceId: device.deviceId,
                    label: device.label || `Speaker ${device.deviceId.slice(0, 5)}`,
                    kind: 'audiooutput' as const,
                }));

            return [...this.audioDevices, ...this.videoDevices, ...this.audioOutputDevices];
        } catch (error) {
            debug.error('Failed to enumerate devices:', error);
            throw error;
        }
    }

    async getUserMedia(constraints: MediaConstraints): Promise<MediaStream> {
        debug.log('MediaManager: Requesting user media with constraints:', constraints);
        debug.log('MediaManager: Current URL:', window.location.href);
        debug.log('MediaManager: Is secure context:', window.isSecureContext);
        debug.log('MediaManager: Protocol:', window.location.protocol);

        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia is not supported in this browser');
            }

            debug.log('MediaManager: Checking permissions...');
            try {
                const micPermission = await navigator.permissions.query({
                    name: 'microphone' as PermissionName,
                });
                const cameraPermission = await navigator.permissions.query({
                    name: 'camera' as PermissionName,
                });
                debug.log('MediaManager: Microphone permission:', micPermission.state);
                debug.log('MediaManager: Camera permission:', cameraPermission.state);
            } catch (permError) {
                debug.warn('MediaManager: Could not check permissions:', permError);
            }

            debug.log('MediaManager: Calling navigator.mediaDevices.getUserMedia...');
            const stream = await navigator.mediaDevices.getUserMedia(constraints);

            debug.log('MediaManager: Successfully got media stream:', {
                id: stream.id,
                active: stream.active,
                audioTracks: stream.getAudioTracks().length,
                videoTracks: stream.getVideoTracks().length,
            });

            if (this.localStream) {
                debug.log('MediaManager: Stopping existing stream...');
                this.stopLocalStream();
            }

            this.localStream = stream;
            return stream;
        } catch (error) {
            debug.error('MediaManager: Failed to get user media:', error);
            debug.error('MediaManager: Error details:', {
                name: (error as any)?.name,
                message: (error as any)?.message,
                constraint: (error as any)?.constraint,
            });
            throw this.createUserFriendlyError(error);
        }
    }

    async getDisplayMedia(): Promise<MediaStream> {
        try {
            return await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true,
            });
        } catch (error) {
            debug.error('Failed to get display media:', error);
            throw error;
        }
    }

    async switchCamera(deviceId?: string): Promise<MediaStream> {
        if (!this.localStream) {
            throw new Error('No active stream to switch camera');
        }

        const currentTrack = this.localStream.getVideoTracks()[0];
        const settings = currentTrack?.getSettings();
        const currentDeviceId = settings?.deviceId;
        const currentFacing = settings?.facingMode;

        // Decide what to switch to. Prefer cycling to the next enumerated camera by deviceId.
        // Mobile browsers often expose only one videoinput even with two physical cameras, so
        // when there is no distinct deviceId to target we flip the facingMode (front <-> back)
        // instead. An explicit deviceId argument always wins.
        await this.enumerateDevices();
        const cameras = this.videoDevices;
        let videoConstraint: MediaTrackConstraints;
        if (deviceId) {
            videoConstraint = { deviceId: { exact: deviceId } };
        } else if (cameras.length > 1 && currentDeviceId) {
            const currentIndex = cameras.findIndex((c) => c.deviceId === currentDeviceId);
            const nextDeviceId = cameras[(currentIndex + 1) % cameras.length].deviceId;
            videoConstraint = { deviceId: { exact: nextDeviceId } };
        } else {
            const nextFacing = currentFacing === 'environment' ? 'user' : 'environment';
            videoConstraint = { facingMode: { ideal: nextFacing } };
        }

        // Stop the current camera BEFORE opening the next one. Phones generally can't hold two
        // cameras open at once, so requesting the new stream while the old is still live hangs
        // or throws NotReadableError ("camera in use") — the freeze the user hit. Audio tracks
        // are left untouched.
        if (currentTrack) {
            currentTrack.stop();
            this.localStream.removeTrack(currentTrack);
        }

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
            this.localStream.addTrack(newStream.getVideoTracks()[0]);
            return this.localStream;
        } catch (error) {
            debug.error('Failed to switch camera:', error);
            // The old camera is already stopped, so try to reacquire a camera to avoid leaving
            // the call with no video at all.
            try {
                const restored = await navigator.mediaDevices.getUserMedia({
                    video: currentDeviceId ? { deviceId: { exact: currentDeviceId } } : true,
                });
                this.localStream.addTrack(restored.getVideoTracks()[0]);
            } catch (restoreError) {
                debug.error('Failed to restore camera after switch failure:', restoreError);
            }
            throw this.createUserFriendlyError(error);
        }
    }

    async switchMicrophone(deviceId: string): Promise<MediaStream> {
        if (!this.localStream) {
            throw new Error('No active stream to switch microphone');
        }

        const videoTracks = this.localStream.getVideoTracks();

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } },
                video: videoTracks.length > 0,
            });

            const oldAudioTracks = this.localStream.getAudioTracks();
            oldAudioTracks.forEach((track) => {
                track.stop();
                this.localStream!.removeTrack(track);
            });

            const newAudioTracks = newStream.getAudioTracks();
            newAudioTracks.forEach((track) => {
                this.localStream!.addTrack(track);
            });

            return this.localStream;
        } catch (error) {
            debug.error('Failed to switch microphone:', error);
            throw error;
        }
    }

    toggleAudio(enabled?: boolean): boolean {
        if (!this.localStream) return false;

        const audioTracks = this.localStream.getAudioTracks();
        const shouldEnable = enabled ?? !audioTracks[0]?.enabled;

        audioTracks.forEach((track) => {
            track.enabled = shouldEnable;
        });

        return shouldEnable;
    }

    toggleVideo(enabled?: boolean): boolean {
        if (!this.localStream) return false;

        const videoTracks = this.localStream.getVideoTracks();
        const shouldEnable = enabled ?? !videoTracks[0]?.enabled;

        videoTracks.forEach((track) => {
            track.enabled = shouldEnable;
        });

        return shouldEnable;
    }

    isAudioEnabled(): boolean {
        if (!this.localStream) return false;
        const audioTracks = this.localStream.getAudioTracks();
        return audioTracks.some((track) => track.enabled);
    }

    isVideoEnabled(): boolean {
        if (!this.localStream) return false;
        const videoTracks = this.localStream.getVideoTracks();
        return videoTracks.some((track) => track.enabled);
    }

    getLocalStream(): MediaStream | null {
        return this.localStream;
    }

    stopLocalStream(): void {
        if (this.localStream) {
            this.localStream.getTracks().forEach((track) => {
                track.stop();
            });
            this.localStream = null;
        }
    }

    getAudioDevices(): MediaDevice[] {
        return [...this.audioDevices];
    }

    getVideoDevices(): MediaDevice[] {
        return [...this.videoDevices];
    }

    getAudioOutputDevices(): MediaDevice[] {
        return [...this.audioOutputDevices];
    }

    async setAudioOutputDevice(elementId: string, deviceId: string): Promise<void> {
        const audioElement = document.getElementById(elementId) as HTMLAudioElement;
        if (audioElement && audioElement.setSinkId) {
            try {
                await audioElement.setSinkId(deviceId);
            } catch (error) {
                debug.error('Failed to set audio output device:', error);
                throw error;
            }
        }
    }

    checkMediaPermissions(): Promise<{ audio: boolean; video: boolean }> {
        // eslint-disable-next-line no-async-promise-executor -- the executor's awaits are fully wrapped in try/catch and it always resolves
        return new Promise(async (resolve) => {
            const permissions = { audio: false, video: false };

            try {
                const audioPermission = await navigator.permissions.query({
                    name: 'microphone' as PermissionName,
                });
                permissions.audio = audioPermission.state === 'granted';
            } catch (error) {
                debug.warn('Could not check microphone permission:', error);
            }

            try {
                const videoPermission = await navigator.permissions.query({
                    name: 'camera' as PermissionName,
                });
                permissions.video = videoPermission.state === 'granted';
            } catch (error) {
                debug.warn('Could not check camera permission:', error);
            }

            resolve(permissions);
        });
    }

    private createUserFriendlyError(error: any): Error {
        if (error.name === 'NotAllowedError') {
            return new Error(
                'Camera and microphone access was denied. Please allow access and try again.'
            );
        } else if (error.name === 'NotFoundError') {
            return new Error(
                'No camera or microphone found. Please connect a device and try again.'
            );
        } else if (error.name === 'NotReadableError') {
            return new Error('Camera or microphone is already in use by another application.');
        } else if (error.name === 'OverconstrainedError') {
            return new Error('Camera or microphone does not meet the required specifications.');
        }

        return new Error(`Media access failed: ${error.message || error.name || 'Unknown error'}`);
    }

    onDeviceChange(callback: (devices: MediaDevice[]) => void): () => void {
        const handler = async () => {
            const devices = await this.enumerateDevices();
            callback(devices);
        };

        navigator.mediaDevices.addEventListener('devicechange', handler);

        return () => {
            navigator.mediaDevices.removeEventListener('devicechange', handler);
        };
    }

    static isSupported(): boolean {
        return !!(
            navigator.mediaDevices &&
            typeof navigator.mediaDevices.getUserMedia === 'function' &&
            typeof window.RTCPeerConnection === 'function'
        );
    }
}

export const mediaManager = new MediaManager();
