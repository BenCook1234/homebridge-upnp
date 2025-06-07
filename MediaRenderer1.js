const Device = require('./Device');
const homebridge = require('./homebridge');

class MediaRenderer1 extends Device {
    constructor(platform, USN, accessory) {
        super(platform, USN, accessory);

        this._isPlaying = false;
        this._handleEvent = this._handleEvent.bind(this);
        this._handleAVTransportEvent = this._handleAVTransportEvent.bind(this);
    }

    _createAccessory(description) {
        let accessory = this._accessory;

        if (!accessory) {
            let UUID = description.UDN.substr('uuid:'.length);
            if (!homebridge.hap.uuid.isValid(UUID)) {
                UUID = homebridge.hap.uuid.generate(UUID);
            }

            accessory = new homebridge.platformAccessory(description.friendlyName, UUID);
            accessory.context.USN = this.USN;
            accessory.context.ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';
            this._accessory = accessory;
        }

        this._updateAccessory(description);

        const { Service, Characteristic } = homebridge.hap;

        // === TV Service ===
        let tvService = this.accessory.getServiceById(Service.Television, 'MediaTV');
        if (!tvService) {
            tvService = new Service.Television('Media Renderer', 'MediaTV');
            this.accessory.addService(tvService);
        }

        tvService
            .setCharacteristic(Characteristic.ConfiguredName, description.friendlyName || 'UPnP TV')
            .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

        tvService.getCharacteristic(Characteristic.Active)
            .on('get', (callback) => {
                callback(null, this._isPlaying ? 1 : 0);
            })
            .on('set', (value, callback) => {
                if (value === 1) {
                    this._setPlay(callback);
                } else {
                    this._setPause(callback);
                }
            });

        // === Speaker Service ===
        let speakerService = this.accessory.getServiceById(Service.TelevisionSpeaker, 'Speaker');
        if (!speakerService) {
            speakerService = new Service.TelevisionSpeaker('Speaker', 'Speaker');
            this.accessory.addService(speakerService);
        }

        speakerService
            .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
            .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

        speakerService.getCharacteristic(Characteristic.Volume)
            .on('get', this._getVolume.bind(this))
            .on('set', this._setVolume.bind(this));

        speakerService.getCharacteristic(Characteristic.Mute)
            .on('get', (callback) => this._getMute((err, value) => callback(err, !!value)))
            .on('set', (value, callback) => this._setMute(value, callback));
    }

    _updateAccessory(description) {
        const informationService = this.accessory.getService(homebridge.hap.Service.AccessoryInformation);

        if (description.friendlyName) {
            informationService.getCharacteristic(homebridge.hap.Characteristic.Manufacturer).updateValue(description.friendlyName);
        }

        if (description.manufacturer) {
            informationService.getCharacteristic(homebridge.hap.Characteristic.Manufacturer).updateValue(description.manufacturer);
        }

        if (description.modelName) {
            informationService.getCharacteristic(homebridge.hap.Characteristic.Model).updateValue(description.modelName);
        }

        if (description.serialNumber) {
            informationService.getCharacteristic(homebridge.hap.Characteristic.SerialNumber).updateValue(description.serialNumber);
        }
    }

    onStart() {
        this._client.subscribe('RenderingControl', this._handleEvent);
        this._client.subscribe('AVTransport', this._handleAVTransportEvent);
    }

    onAlive() {
        this._getMute((err, value) => {
            if (err) {
                this._platform.log.error(err);
                return;
            }
            const speakerService = this.accessory.getServiceById(homebridge.hap.Service.TelevisionSpeaker, 'Speaker');
            if (speakerService) {
                speakerService.getCharacteristic(homebridge.hap.Characteristic.Mute).updateValue(!!value);
            }
        });

        this._getVolume((err, value) => {
            if (err) {
                this._platform.log.error(err);
                return;
            }
            const speakerService = this.accessory.getServiceById(homebridge.hap.Service.TelevisionSpeaker, 'Speaker');
            if (speakerService) {
                speakerService.getCharacteristic(homebridge.hap.Characteristic.Volume).updateValue(value);
            }
        });

        this._client.callAction('AVTransport', 'GetTransportInfo', {
            InstanceID: 0
        }, (err, result) => {
            if (!err && result.CurrentTransportState) {
                this._handleAVTransportEvent({ TransportState: result.CurrentTransportState });
            }
        });
    }

    onBye() {
        const tvService = this.accessory.getServiceById(homebridge.hap.Service.Television, 'MediaTV');
        if (tvService) {
            tvService.getCharacteristic(homebridge.hap.Characteristic.Active).updateValue(0);
        }
    }

    stop() {
        if (this._client) {
            this._client.unsubscribe('RenderingControl', this._handleEvent);
            this._client.unsubscribe('AVTransport', this._handleAVTransportEvent);
        }
    }

    _handleEvent(event) {
        if (event.Volume) {
            const volume = parseInt(event.Volume);
            const speakerService = this.accessory.getServiceById(homebridge.hap.Service.TelevisionSpeaker, 'Speaker');
            if (speakerService) {
                speakerService.getCharacteristic(homebridge.hap.Characteristic.Volume).updateValue(volume);
            }
        }

        if (event.Mute) {
            const mute = Boolean(parseInt(event.Mute));
            const speakerService = this.accessory.getServiceById(homebridge.hap.Service.TelevisionSpeaker, 'Speaker');
            if (speakerService) {
                speakerService.getCharacteristic(homebridge.hap.Characteristic.Mute).updateValue(mute);
            }
        }
    }

    _handleAVTransportEvent(event) {
        if (event.TransportState) {
            const state = event.TransportState;
            this._platform.log(`Playback state changed: ${state}`);

            this._isPlaying = (state === 'PLAYING');

            const tvService = this.accessory.getServiceById(homebridge.hap.Service.Television, 'MediaTV');
            if (tvService) {
                tvService.getCharacteristic(homebridge.hap.Characteristic.Active)
                    .updateValue(this._isPlaying ? 1 : 0);
            }
        }
    }

    _setPlay(callback) {
        if (!this._client) return callback(new Error('Client not initialized'));
        this._client.callAction('AVTransport', 'Play', {
            InstanceID: 0,
            Speed: '1'
        }, (err) => {
            if (!err) this._isPlaying = true;
            callback(err);
        });
    }

    _setPause(callback) {
        if (!this._client) return callback(new Error('Client not initialized'));
        this._client.callAction('AVTransport', 'Pause', {
            InstanceID: 0
        }, (err) => {
            if (!err) this._isPlaying = false;
            callback(err);
        });
    }

    _getMute(callback) {
        if (!this._client) {
            callback(new Error('Client not initialized'));
            return;
        }

        this._client.callAction('RenderingControl', 'GetMute', {
            InstanceID: 0,
            Channel: 'Master'
        }, function (err, result) {
            if (err) {
                callback(err);
                return;
            }

            callback(null, Boolean(parseInt(result.CurrentMute)));
        });
    }

    _getVolume(callback) {
        if (!this._client) {
            callback(new Error('Client not initialized'));
            return;
        }

        this._client.callAction('RenderingControl', 'GetVolume', {
            InstanceID: 0,
            Channel: 'Master'
        }, function (err, result) {
            if (err) {
                callback(err);
                return;
            }

            callback(null, parseInt(result.CurrentVolume));
        });
    }

    _setMute(value, callback) {
        if (!this._client) {
            callback(new Error('Client not initialized'));
            return;
        }

        this._client.callAction('RenderingControl', 'SetMute', {
            InstanceID: 0,
            Channel: 'Master',
            DesiredMute: value
        }, callback);
    }

    _setVolume(value, callback) {
        if (!this._client) {
            callback(new Error('Client not initialized'));
            return;
        }

        this._client.callAction('RenderingControl', 'SetVolume', {
            InstanceID: 0,
            Channel: 'Master',
            DesiredVolume: value
        }, callback);
    }
}

module.exports = MediaRenderer1;
