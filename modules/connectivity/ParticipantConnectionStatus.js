/* global __filename */
import { getLogger } from 'jitsi-meet-logger';
import * as JitsiConferenceEvents from '../../JitsiConferenceEvents';
import * as JitsiTrackEvents from '../../JitsiTrackEvents';
import * as MediaType from '../../service/RTC/MediaType';
import browser from '../browser';
import RTCEvents from '../../service/RTC/RTCEvents';
import Statistics from '../statistics/statistics';
import { createParticipantConnectionStatusEvent } from '../../service/statistics/AnalyticsEvents';

const logger = getLogger(__filename);

/**
 * Default value of 500 milliseconds for
 * {@link ParticipantConnectionStatus.outOfLastNTimeout}.
 *
 * @type {number}
 */
const DEFAULT_NOT_IN_LAST_N_TIMEOUT = 500;

/**
 * Default value of 2000 milliseconds for
 * {@link ParticipantConnectionStatus.rtcMuteTimeout}.
 *
 * @type {number}
 */
const DEFAULT_RTC_MUTE_TIMEOUT = 10000;

/**
 * The time to wait a track to be restored. Track which was out of lastN
 * should be inactive and when entering lastN it becomes restoring and when
 * data is received from bridge it will become active, but if no data is
 * received for some time we set status of that participant connection to
 * interrupted.
 * @type {number}
 */
const DEFAULT_RESTORING_TIMEOUT = 10000;

/**
 * Participant connection statuses.
 *
 * @type {{
 *      ACTIVE: string,
 *      INACTIVE: string,
 *      INTERRUPTED: string,
 *      RESTORING: string
 * }}
 */
export const ParticipantConnectionStatus = {
    /**
     * Status indicating that connection is currently active.
     */
    ACTIVE: 'active',

    /**
     * Status indicating that connection is currently inactive.
     * Inactive means the connection was stopped on purpose from the bridge,
     * like exiting lastN or adaptivity decided to drop video because of not
     * enough bandwidth.
     */
    INACTIVE: 'inactive',

    /**
     * Status indicating that connection is currently interrupted.
     */
    INTERRUPTED: 'interrupted',

    /**
     * Status indicating that connection is currently restoring.
     */
    RESTORING: 'restoring'
};

/**
 * Class is responsible for emitting
 * JitsiConferenceEvents.PARTICIPANT_CONN_STATUS_CHANGED events.
 */
export default class ParticipantConnectionStatusHandler {
    /* eslint-disable max-params*/
    /**
     * Calculates the new {@link ParticipantConnectionStatus} based on
     * the values given for some specific remote user. It is assumed that
     * the conference is currently in the JVB mode (in contrary to the P2P mode)
     * @param {boolean} isConnectionActiveByJvb true if the JVB did not get any
     * data from the user for the last 15 seconds.
     * @param {boolean} isInLastN indicates whether the user is in the last N
     * set. When set to false it means that JVB is not sending any video for
     * the user.
     * @param {boolean} isRestoringTimedout if true it means that the user has
     * been outside of last N too long to be considered
     * {@link ParticipantConnectionStatus.RESTORING}.
     * @param {boolean} isVideoMuted true if the user is video muted and we
     * should not expect to receive any video.
     * @param {boolean} isVideoTrackFrozen if the current browser support video
     * frozen detection then it will be set to true when the video track is
     * frozen. If the current browser does not support frozen detection the it's
     * always false.
     * @return {ParticipantConnectionStatus} the new connection status for
     * the user for whom the values above were provided.
     * @private
     */
    static _getNewStateForJvbMode(
            isConnectionActiveByJvb,
            isInLastN,
            isRestoringTimedout,
            isVideoMuted,
            isVideoTrackFrozen) {
        if (!isConnectionActiveByJvb) {
            // when there is a connection problem signaled from jvb
            // it means no media was flowing for at least 15secs, so both audio
            // and video are most likely interrupted
            return ParticipantConnectionStatus.INTERRUPTED;
        } else if (isVideoMuted) {
            // If the connection is active according to JVB and the user is
            // video muted there is no way for the connection to be inactive,
            // because the detection logic below only makes sense for video.
            return ParticipantConnectionStatus.ACTIVE;
        }

        // Logic when isVideoTrackFrozen is supported
        if (browser.supportsVideoMuteOnConnInterrupted()) {
            if (!isVideoTrackFrozen) {
                // If the video is playing we're good
                return ParticipantConnectionStatus.ACTIVE;
            } else if (isInLastN) {
                return isRestoringTimedout
                    ? ParticipantConnectionStatus.INTERRUPTED
                    : ParticipantConnectionStatus.RESTORING;
            }

            return ParticipantConnectionStatus.INACTIVE;
        }

        // Because this browser is incapable of detecting frozen video we must
        // rely on the lastN value
        return isInLastN
            ? ParticipantConnectionStatus.ACTIVE
            : ParticipantConnectionStatus.INACTIVE;
    }

    /* eslint-enable max-params*/

    /**
     * In P2P mode we don't care about any values coming from the JVB and
     * the connection status can be only active or interrupted.
     * @param {boolean} isVideoMuted the user if video muted
     * @param {boolean} isVideoTrackFrozen true if the video track for
     * the remote user is currently frozen. If the current browser does not
     * support video frozen detection then it's always false.
     * @return {ParticipantConnectionStatus}
     * @private
     */
    static _getNewStateForP2PMode(isVideoMuted, isVideoTrackFrozen) {
        if (!browser.supportsVideoMuteOnConnInterrupted()) {
            // There's no way to detect problems in P2P when there's no video
            // track frozen detection...
            return ParticipantConnectionStatus.ACTIVE;
        }

        return isVideoMuted || !isVideoTrackFrozen
            ? ParticipantConnectionStatus.ACTIVE
            : ParticipantConnectionStatus.INTERRUPTED;
    }

    /**
     * Creates new instance of <tt>ParticipantConnectionStatus</tt>.
     *
     * @constructor
     * @param {RTC} rtc the RTC service instance
     * @param {JitsiConference} conference parent conference instance
     * @param {Object} options
     * @param {number} [options.rtcMuteTimeout=2000] custom value for
     * {@link ParticipantConnectionStatus.rtcMuteTimeout}.
     * @param {number} [options.outOfLastNTimeout=500] custom value for
     * {@link ParticipantConnectionStatus.outOfLastNTimeout}.
     */
    constructor(rtc, conference, options) {
        this.rtc = rtc;
        this.conference = conference;

        /**
         * A map of the "endpoint ID"(which corresponds to the resource part
         * of MUC JID(nickname)) to the timeout callback IDs scheduled using
         * window.setTimeout.
         * @type {Object.<string, number>}
         */
        this.trackTimers = {};

        /**
         * This map holds the endpoint connection status received from the JVB
         * (as it might be different than the one stored in JitsiParticipant).
         * Required for getting back in sync when remote video track is removed.
         * @type {Object.<string, boolean>}
         */
        this.connStatusFromJvb = { };

        /**
         * If video track frozen detection through RTC mute event is supported,
         * we wait some time until video track is considered frozen. But because
         * when the user falls out of last N it is expected for the video to
         * freeze this timeout must be significantly reduced in "out of last N"
         * case.
         *
         * Basically this value is used instead of {@link rtcMuteTimeout} when
         * user is not in last N.
         * @type {number}
         */
        this.outOfLastNTimeout
            = typeof options.outOfLastNTimeout === 'number'
                ? options.outOfLastNTimeout : DEFAULT_NOT_IN_LAST_N_TIMEOUT;

        /**
         * How long we're going to wait after the RTC video track muted event
         * for the corresponding signalling mute event, before the connection
         * interrupted is fired. The default value is
         * {@link DEFAULT_RTC_MUTE_TIMEOUT}.
         *
         * @type {number} amount of time in milliseconds
         */
        this.rtcMuteTimeout
            = typeof options.rtcMuteTimeout === 'number'
                ? options.rtcMuteTimeout : DEFAULT_RTC_MUTE_TIMEOUT;

        /**
         * This map holds a timestamp indicating  when participant's video track
         * was RTC muted (it is assumed that each participant can have only 1
         * video track at a time). The purpose of storing the timestamp is to
         * avoid the transition to disconnected status in case of legitimate
         * video mute operation where the signalling video muted event can
         * arrive shortly after RTC muted event.
         *
         * The key is participant's ID which is the same as endpoint id in
         * the Colibri conference allocated on the JVB.
         *
         * The value is a timestamp measured in milliseconds obtained with
         * <tt>Date.now()</tt>.
         *
         * FIXME merge this logic with NO_DATA_FROM_SOURCE event
         *       implemented in JitsiLocalTrack by extending the event to
         *       the remote track and allowing to set different timeout for
         *       local and remote tracks.
         *
         * @type {Object.<string, number>}
         */
        this.rtcMutedTimestamp = { };
        logger.info(`RtcMuteTimeout set to: ${this.rtcMuteTimeout}`);

        /**
         * This map holds the timestamps indicating when participant's video
         * entered lastN set. Participants entering lastN will have connection
         * status restoring and when we start receiving video will become
         * active, but if video is not received for certain time
         * {@link DEFAULT_RESTORING_TIMEOUT} that participant connection status
         * will become interrupted.
         *
         * @type {Map<string, number>}
         */
        this.enteredLastNTimestamp = new Map();

        /**
         * A map of the "endpoint ID"(which corresponds to the resource part
         * of MUC JID(nickname)) to the restoring timeout callback IDs
         * scheduled using window.setTimeout.
         *
         * @type {Map<string, number>}
         */
        this.restoringTimers = new Map();

        /**
         * A map that holds the current connection status (along with all the internal events that happen
         * while in that state).
         *
         * The goal is to send this information to the analytics backend for post-mortem analysis.
         */
        this.peerConnStatusMap = new Map();
    }

    /**
     * Gets the video frozen timeout for given user.
     * @param {string} id endpoint/participant ID
     * @return {number} how long are we going to wait since RTC video muted
     * even, before a video track is considered frozen.
     * @private
     */
    _getVideoFrozenTimeout(id) {
        return this.rtc.isInLastN(id)
            ? this.rtcMuteTimeout : this.outOfLastNTimeout;
    }

    /**
     * Initializes <tt>ParticipantConnectionStatus</tt> and bind required event
     * listeners.
     */
    init() {

        this._onEndpointConnStatusChanged
            = this.onEndpointConnStatusChanged.bind(this);

        this.rtc.addListener(
            RTCEvents.ENDPOINT_CONN_STATUS_CHANGED,
            this._onEndpointConnStatusChanged);

        // Handles P2P status changes
        this._onP2PStatus = this.refreshConnectionStatusForAll.bind(this);
        this.conference.on(JitsiConferenceEvents.P2P_STATUS, this._onP2PStatus);

        // On some browsers MediaStreamTrack trigger "onmute"/"onunmute"
        // events for video type tracks when they stop receiving data which is
        // often a sign that remote user is having connectivity issues
        if (browser.supportsVideoMuteOnConnInterrupted()) {

            this._onTrackRtcMuted = this.onTrackRtcMuted.bind(this);
            this.rtc.addListener(
                RTCEvents.REMOTE_TRACK_MUTE, this._onTrackRtcMuted);

            this._onTrackRtcUnmuted = this.onTrackRtcUnmuted.bind(this);
            this.rtc.addListener(
                RTCEvents.REMOTE_TRACK_UNMUTE, this._onTrackRtcUnmuted);

            // Track added/removed listeners are used to bind "mute"/"unmute"
            // event handlers
            this._onRemoteTrackAdded = this.onRemoteTrackAdded.bind(this);
            this.conference.on(
                JitsiConferenceEvents.TRACK_ADDED,
                this._onRemoteTrackAdded);

            this._onRemoteTrackRemoved = this.onRemoteTrackRemoved.bind(this);
            this.conference.on(
                JitsiConferenceEvents.TRACK_REMOVED,
                this._onRemoteTrackRemoved);

            // Listened which will be bound to JitsiRemoteTrack to listen for
            // signalling mute/unmute events.
            this._onSignallingMuteChanged
                = this.onSignallingMuteChanged.bind(this);
        }

        this._onLastNChanged = this._onLastNChanged.bind(this);
        this.conference.on(
            JitsiConferenceEvents.LAST_N_ENDPOINTS_CHANGED,
            this._onLastNChanged);

        this._onLastNValueChanged
            = this.refreshConnectionStatusForAll.bind(this);
        this.rtc.on(
            RTCEvents.LASTN_VALUE_CHANGED, this._onLastNValueChanged);
    }

    /**
     * Removes all event listeners and disposes of all resources held by this
     * instance.
     */
    dispose() {

        this.rtc.removeListener(
            RTCEvents.ENDPOINT_CONN_STATUS_CHANGED,
            this._onEndpointConnStatusChanged);

        if (browser.supportsVideoMuteOnConnInterrupted()) {
            this.rtc.removeListener(
                RTCEvents.REMOTE_TRACK_MUTE,
                this._onTrackRtcMuted);
            this.rtc.removeListener(
                RTCEvents.REMOTE_TRACK_UNMUTE,
                this._onTrackRtcUnmuted);

            this.conference.off(
                JitsiConferenceEvents.TRACK_ADDED,
                this._onRemoteTrackAdded);
            this.conference.off(
                JitsiConferenceEvents.TRACK_REMOVED,
                this._onRemoteTrackRemoved);
        }

        this.conference.off(
            JitsiConferenceEvents.LAST_N_ENDPOINTS_CHANGED,
            this._onLastNChanged);

        this.rtc.removeListener(
            RTCEvents.LASTN_VALUE_CHANGED, this._onLastNValueChanged);

        this.conference.off(
            JitsiConferenceEvents.P2P_STATUS, this._onP2PStatus);

        const participantIds = Object.keys(this.trackTimers);

        for (const participantId of participantIds) {
            this.clearTimeout(participantId);
            this.clearRtcMutedTimestamp(participantId);
        }

        // Clear RTC connection status cache
        this.connStatusFromJvb = {};
    }

    /**
     * Handles RTCEvents.ENDPOINT_CONN_STATUS_CHANGED triggered when we receive
     * notification over the data channel from the bridge about endpoint's
     * connection status update.
     * @param {string} endpointId the endpoint ID(MUC nickname/resource JID)
     * @param {boolean} isActive true if the connection is OK or false otherwise
     */
    onEndpointConnStatusChanged(endpointId, isActive) {

        logger.debug(
            `Detector RTCEvents.ENDPOINT_CONN_STATUS_CHANGED(${Date.now()}): ${
                endpointId}: ${isActive}`);

        // Filter out events for the local JID for now
        if (endpointId !== this.conference.myUserId()) {
            // Store the status received over the data channels
            this.connStatusFromJvb[endpointId] = isActive;
            this.figureOutConnectionStatus(endpointId);
        }
    }

    /**
     * Changes connection status.
     * @param {JitsiParticipant} participant
     * @param newStatus
     */
    _changeConnectionStatus(participant, newStatus) {
        if (participant.getConnectionStatus() !== newStatus) {

            const endpointId = participant.getId();

            participant._setConnectionStatus(newStatus);

            logger.debug(
                `Emit endpoint conn status(${Date.now()}) ${endpointId}: ${
                    newStatus}`);

            // Log the event on CallStats
            Statistics.sendLog(
                JSON.stringify({
                    id: 'peer.conn.status',
                    participant: endpointId,
                    status: newStatus
                }));


            this.conference.eventEmitter.emit(
                JitsiConferenceEvents.PARTICIPANT_CONN_STATUS_CHANGED,
                endpointId, newStatus);
        }
    }

    /**
     * Reset the postponed "connection interrupted" event which was previously
     * scheduled as a timeout on RTC 'onmute' event.
     *
     * @param {string} participantId the participant for which the "connection
     * interrupted" timeout was scheduled
     */
    clearTimeout(participantId) {
        if (this.trackTimers[participantId]) {
            window.clearTimeout(this.trackTimers[participantId]);
            this.trackTimers[participantId] = null;
        }
    }

    /**
     * Clears the timestamp of the RTC muted event for participant's video track
     * @param {string} participantId the id of the conference participant which
     * is the same as the Colibri endpoint ID of the video channel allocated for
     * the user on the videobridge.
     */
    clearRtcMutedTimestamp(participantId) {
        this.rtcMutedTimestamp[participantId] = null;
    }

    /**
     * Bind signalling mute event listeners for video {JitsiRemoteTrack} when
     * a new one is added to the conference.
     *
     * @param {JitsiTrack} remoteTrack the {JitsiTrack} which is being added to
     * the conference.
     */
    onRemoteTrackAdded(remoteTrack) {
        if (!remoteTrack.isLocal()
                && remoteTrack.getType() === MediaType.VIDEO) {

            logger.debug(
                `Detector on remote track added for: ${
                    remoteTrack.getParticipantId()}`);

            remoteTrack.on(
                JitsiTrackEvents.TRACK_MUTE_CHANGED,
                this._onSignallingMuteChanged);
        }
    }

    /**
     * Removes all event listeners bound to the remote video track and clears
     * any related timeouts.
     *
     * @param {JitsiRemoteTrack} remoteTrack the remote track which is being
     * removed from the conference.
     */
    onRemoteTrackRemoved(remoteTrack) {
        if (!remoteTrack.isLocal()
                && remoteTrack.getType() === MediaType.VIDEO) {

            const endpointId = remoteTrack.getParticipantId();

            logger.debug(`Detector on remote track removed: ${endpointId}`);

            remoteTrack.off(
                JitsiTrackEvents.TRACK_MUTE_CHANGED,
                this._onSignallingMuteChanged);

            this.clearTimeout(endpointId);
            this.clearRtcMutedTimestamp(endpointId);

            this.figureOutConnectionStatus(endpointId);
        }
    }

    /**
     * Checks if given participant's video is considered frozen.
     * @param {JitsiParticipant} participant
     * @return {boolean} <tt>true</tt> if the video has frozen for given
     * participant or <tt>false</tt> when it's either not considered frozen
     * (yet) or if freeze detection is not supported by the current browser.
     *
     * FIXME merge this logic with NO_DATA_FROM_SOURCE event
     *       implemented in JitsiLocalTrack by extending the event to
     *       the remote track and allowing to set different timeout for
     *       local and remote tracks.
     *
     */
    isVideoTrackFrozen(participant) {
        if (!browser.supportsVideoMuteOnConnInterrupted()) {
            return false;
        }

        const id = participant.getId();
        const hasAnyVideoRTCMuted = participant.hasAnyVideoTrackWebRTCMuted();
        const rtcMutedTimestamp = this.rtcMutedTimestamp[id];
        const timeout = this._getVideoFrozenTimeout(id);

        return hasAnyVideoRTCMuted
            && typeof rtcMutedTimestamp === 'number'
            && (Date.now() - rtcMutedTimestamp) >= timeout;
    }

    /**
     * Goes over every participant and updates connectivity status.
     * Should be called when a parameter which affects all of the participants
     * is changed (P2P for example).
     */
    refreshConnectionStatusForAll() {
        const participants = this.conference.getParticipants();

        for (const participant of participants) {
            this.figureOutConnectionStatus(participant.getId());
        }
    }

    /**
     * Figures out (and updates) the current connectivity status for
     * the participant identified by the given id.
     *
     * @param {string} id the participant's id (MUC nickname or Colibri endpoint
     * ID).
     */
    figureOutConnectionStatus(id) {
        const participant = this.conference.getParticipantById(id);

        if (!participant) {
            // Probably the participant is no longer in the conference
            // (at the time of writing this code, participant is
            // detached from the conference and TRACK_REMOVED events are
            // fired),
            // so we don't care, but let's print the warning for
            // debugging purpose
            logger.warn(`figure out conn status - no participant for: ${id}`);

            return;
        }

        const inP2PMode = this.conference.isP2PActive();
        const isRestoringTimedOut = this._isRestoringTimedout(id);
        const audioOnlyMode = this.rtc.getLastN() === 0;

        // NOTE Overriding videoMuted to true for audioOnlyMode should disable
        // any detection based on video playback or the last N.
        const isVideoMuted = participant.isVideoMuted() || audioOnlyMode;
        const isVideoTrackFrozen = this.isVideoTrackFrozen(participant);
        const isInLastN = this.rtc.isInLastN(id);
        let isConnActiveByJvb = this.connStatusFromJvb[id];

        if (typeof isConnActiveByJvb !== 'boolean') {
            // If no status was received from the JVB it means that it's active
            // (the bridge does not send notification unless there is a problem)
            logger.debug('Assuming connection active by JVB - no notification');
            isConnActiveByJvb = true;
        }

        const newState
            = inP2PMode
                ? ParticipantConnectionStatusHandler._getNewStateForP2PMode(
                    isVideoMuted,
                    isVideoTrackFrozen)
                : ParticipantConnectionStatusHandler._getNewStateForJvbMode(
                    isConnActiveByJvb,
                    isInLastN,
                    isRestoringTimedOut,
                    isVideoMuted,
                    isVideoTrackFrozen);

        // if the new state is not restoring clear timers and timestamps
        // that we use to track the restoring state
        if (newState !== ParticipantConnectionStatus.RESTORING) {
            this._clearRestoringTimer(id);
        }

        logger.debug(
            `Figure out conn status for ${id}, is video muted: ${
                isVideoMuted} is active(jvb): ${
                isConnActiveByJvb} video track frozen: ${
                isVideoTrackFrozen} p2p mode: ${
                inP2PMode} is in last N: ${
                isInLastN} currentStatus => newStatus: ${
                participant.getConnectionStatus()} => ${newState}`);

        const nowMs = new Date().getTime();
        const internalState = {
            'instantMs': nowMs,
            'isVideoMuted': isVideoMuted,
            'isConnActiveByJvb': isConnActiveByJvb,
            'isVideoTrackFrozen': isVideoTrackFrozen,
            'inP2PMode': inP2PMode,
            'inInLastN': isInLastN
        };

        if (!this.peerConnStatusMap[id] || this.peerConnStatusMap[id].state !== newState) {
            // The peer connection status has changed. Compute the duration of the current
            // connection status and send it as an analytics event.
            if (this.peerConnStatusMap[id]) {
                this.peerConnStatusMap[id].value = nowMs - this.peerConnStatusMap[id].startedMs;
                Statistics.sendAnalytics(
                    createParticipantConnectionStatusEvent(this.peerConnStatusMap[id]));
            }

            // And start a new status for the participant.
            this.peerConnStatusMap[id] = {
                'internalStates': [ internalState ],
                'state': newState,
                'startedMs': nowMs
            };
        } else {
            // The connection status hasn't changed, but there was an internal state change.
            // Register the internal state.
            this.peerConnStatusMap[id].internalStates.push(internalState);
        }

        this._changeConnectionStatus(participant, newState);
    }

    /**
     * On change in Last N set check all leaving and entering participants to
     * change their corresponding statuses.
     *
     * @param {Array<string>} leavingLastN array of ids leaving lastN.
     * @param {Array<string>} enteringLastN array of ids entering lastN.
     * @private
     */
    _onLastNChanged(leavingLastN = [], enteringLastN = []) {
        const now = Date.now();

        logger.debug(
            'leaving/entering lastN', leavingLastN, enteringLastN, now);

        for (const id of leavingLastN) {
            this.enteredLastNTimestamp.delete(id);
            this._clearRestoringTimer(id);
            this.figureOutConnectionStatus(id);
        }
        for (const id of enteringLastN) {
            // store the timestamp this id is entering lastN
            this.enteredLastNTimestamp.set(id, now);
            this.figureOutConnectionStatus(id);
        }
    }

    /**
     * Clears the restoring timer for participant's video track and the
     * timestamp for entering lastN.
     *
     * @param {string} participantId the id of the conference participant which
     * is the same as the Colibri endpoint ID of the video channel allocated for
     * the user on the videobridge.
     */
    _clearRestoringTimer(participantId) {
        const rTimer = this.restoringTimers.get(participantId);

        if (rTimer) {
            clearTimeout(rTimer);
            this.restoringTimers.delete(participantId);
        }
    }

    /**
     * Checks whether a track had stayed enough in restoring state, compares
     * current time and the time the track entered in lastN. If it hasn't
     * timedout and there is no timer added, add new timer in order to give it
     * more time to become active or mark it as interrupted on next check.
     *
     * @param {string} participantId the id of the conference participant which
     * is the same as the Colibri endpoint ID of the video channel allocated for
     * the user on the videobridge.
     * @returns {boolean} <tt>true</tt> if the track was in restoring state
     * more than the timeout ({@link DEFAULT_RESTORING_TIMEOUT}.) in order to
     * set its status to interrupted.
     * @private
     */
    _isRestoringTimedout(participantId) {
        const enteredLastNTimestamp
            = this.enteredLastNTimestamp.get(participantId);

        if (enteredLastNTimestamp
            && (Date.now() - enteredLastNTimestamp)
                >= DEFAULT_RESTORING_TIMEOUT) {
            return true;
        }

        // still haven't reached timeout, if there is no timer scheduled,
        // schedule one so we can track the restoring state and change it after
        // reaching the timeout
        const rTimer = this.restoringTimers.get(participantId);

        if (!rTimer) {
            this.restoringTimers.set(participantId, setTimeout(
                () => this.figureOutConnectionStatus(participantId),
                DEFAULT_RESTORING_TIMEOUT));
        }

        return false;
    }

    /**
     * Handles RTC 'onmute' event for the video track.
     *
     * @param {JitsiRemoteTrack} track the video track for which 'onmute' event
     * will be processed.
     */
    onTrackRtcMuted(track) {
        const participantId = track.getParticipantId();
        const participant = this.conference.getParticipantById(participantId);

        logger.debug(`Detector track RTC muted: ${participantId}`, Date.now());
        if (!participant) {
            logger.error(`No participant for id: ${participantId}`);

            return;
        }
        this.rtcMutedTimestamp[participantId] = Date.now();
        if (!participant.isVideoMuted()) {
            // If the user is not muted according to the signalling we'll give
            // it some time, before the connection interrupted event is
            // triggered.
            this.clearTimeout(participantId);

            // The timeout is reduced when user is not in the last N
            const timeout = this._getVideoFrozenTimeout(participantId);

            this.trackTimers[participantId] = window.setTimeout(() => {
                logger.debug(
                    `Set RTC mute timeout for: ${participantId}\
                     of ${timeout} ms`);
                this.clearTimeout(participantId);
                this.figureOutConnectionStatus(participantId);
            }, timeout);
        }
    }

    /**
     * Handles RTC 'onunmute' event for the video track.
     *
     * @param {JitsiRemoteTrack} track the video track for which 'onunmute'
     * event will be processed.
     */
    onTrackRtcUnmuted(track) {
        const participantId = track.getParticipantId();

        logger.debug(
            `Detector track RTC unmuted: ${participantId}`, Date.now());

        this.clearTimeout(participantId);
        this.clearRtcMutedTimestamp(participantId);

        this.figureOutConnectionStatus(participantId);
    }

    /**
     * Here the signalling "mute"/"unmute" events are processed.
     *
     * @param {JitsiRemoteTrack} track the remote video track for which
     * the signalling mute/unmute event will be processed.
     */
    onSignallingMuteChanged(track) {
        const participantId = track.getParticipantId();

        logger.debug(
            `Detector on track signalling mute changed: ${participantId}`,
            track.isMuted());

        this.figureOutConnectionStatus(participantId);
    }
}
