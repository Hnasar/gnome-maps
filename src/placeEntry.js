/* -*- Mode: JS2; indent-tabs-mode: nil; js2-basic-offset: 4 -*- */
/* vim: set et ts=4 sw=4: */
/*
 * Copyright (c) 2013,2014 Jonas Danielsson, Mattias Bengtsson.
 *
 * GNOME Maps is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * GNOME Maps is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with GNOME Maps; if not, see <http://www.gnu.org/licenses/>.
 *
 * Author: Jonas Danielsson <jonas@threetimestwo.org>
 *         Mattias Bengtsson <mattias.jc.bengtsson@gmail.com>
 */

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Geocode = imports.gi.GeocodeGlib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;

const Application = imports.application;
const Location = imports.location;
const Place = imports.place;
const PlaceStore = imports.placeStore;
const SearchPopup = imports.searchPopup;
const Utils = imports.utils;

// Matches coordinates string with the format "<lat>, <long>"
const COORDINATES_REGEX = /^\s*(\-?\d+(?:\.\d+)?)\s*,\s*(\-?\d+(?:\.\d+)?)\s*$/;

const PlaceEntry = new Lang.Class({
    Name: 'PlaceEntry',
    Extends: Gtk.SearchEntry,
    Properties: {
        'place': GObject.ParamSpec.object('place',
                                          'Place',
                                          'The selected place',
                                          GObject.ParamFlags.READABLE |
                                          GObject.ParamFlags.WRITABLE,
                                          Geocode.Place)
    },

    set place(p) {
        if (!this._place && !p)
            return;

        if (this._place && p && this._locEquals(this._place, p))
            return;

        if (p) {
            if (p.name) {
                this.text = p.name;
            } else
                this.text = p.location.latitude + ', ' + p.location.longitude;
        } else
            this.text = '';

        this._place = p;
        this.notify('place');
    },

    get place() {
        return this._place;
    },

    get popover() {
        return this._popover;
    },

    _init: function(props) {
        let numVisible = props.num_visible || 6;
        delete props.num_visible;
        this._mapView = props.mapView;
        delete props.mapView;

        if (!props.loupe)
            props.primary_icon_name = null;
        delete props.loupe;

        let maxChars = props.maxChars;
        delete props.maxChars;

        let parseOnFocusOut = props.parseOnFocusOut;
        delete props.parseOnFocusOut;

        this._matchRoute = props.matchRoute || false;
        delete props.matchRoute;

        this.parent(props);

        this._filter = new Gtk.TreeModelFilter({ child_model: Application.placeStore });
        this._filter.set_visible_func(this._completionVisibleFunc.bind(this),
                                      null,
                                      null);

        this._popover = this._createPopover(numVisible, maxChars);

        this.connect('activate', this._onActivate.bind(this));
        this.connect('changed', (function() {
            if (this._cancellable)
                this._cancellable.cancel();

            this._refreshFilter();

            if (this.text.length === 0) {
                this._popover.hide();
                this.place = null;
                return;
            }

            if (this._filter.iter_n_children(null) > 0)
                this._popover.showCompletion();
            else
                this._popover.hide();
        }).bind(this));

        if (parseOnFocusOut) {
            this.connect('focus-out-event', (function() {
                this._parse();
                return false;
            }).bind(this));
        }
    },

    _locEquals: function(placeA, placeB) {
        if (!placeA.location || !placeB.location)
            return false;

        return (placeA.location.latitude === placeB.location.latitude &&
                placeA.location.longitude === placeB.location.longitude);
    },

    _createPopover: function(numVisible, maxChars) {
        let popover = new SearchPopup.SearchPopup({ num_visible:   numVisible,
                                                    relative_to:   this,
                                                    maxChars:      maxChars});

        this.connect('size-allocate', (function(widget, allocation) {
            // Magic number to make the alignment pixel perfect.
            let width_request = allocation.width + 20;
            popover.width_request = width_request;
        }).bind(this));

        popover.connect('selected', (function(widget, place) {
            this.place = place;
            popover.hide();
        }).bind(this));

        return popover;
    },

    _refreshFilter: function() {
        /* Filter model based on input text */
        this._filter.refilter();
        this._popover.updateCompletion(this._filter, this.text);
    },

    _completionVisibleFunc: function(model, iter) {
        let place = model.get_value(iter, PlaceStore.Columns.PLACE);
        let type = model.get_value(iter, PlaceStore.Columns.TYPE);

        if (!this._matchRoute && type === PlaceStore.PlaceType.RECENT_ROUTE)
            return false;

        if (place !== null)
            return place.match(this.text);
        else
            return false;
    },

    _validateCoordinates: function(lat, lon) {
        return lat <= 90 && lat >= -90 && lon <= 180 && lon >= -180;
    },

    _parseCoordinates: function(text) {
        let match = text.match(COORDINATES_REGEX);

        if (match) {
            let latitude = parseFloat(match[1]);
            let longitude = parseFloat(match[2]);

            if (this._validateCoordinates(latitude, longitude)) {
                return new Location.Location({ latitude: latitude,
                                               longitude: longitude });
            } else
                return null;
        } else
            return null;
    },

    _parse: function() {
        if (this.text.length === 0) {
            this.place = null;
            return true;
        }

        if (this.text.startsWith('geo:')) {
            let location = new Geocode.Location();

            try {
                location.set_from_uri(this.text);
                this.place = new Place.Place({ location: location });
            } catch(e) {
                let msg = _("Failed to parse Geo URI");
                Application.notificationManager.showMessage(msg);
            }

            return true;
        }

        let parsedLocation = this._parseCoordinates(this.text);
        if (parsedLocation) {
            this.place = new Place.Place({ location: parsedLocation });
            return true;
        }

        return false;
    },

    _onActivate: function() {
        if (this._parse())
            return;

        let bbox = this._mapView.view.get_bounding_box();

        this._popover.showSpinner();
        this._cancellable = new Gio.Cancellable();
        Application.geocodeService.search(this.text, bbox, this._cancellable, (function(places) {
            if (!places) {
                this.place = null;
                this._popover.hide();
                return;
            }
            this._popover.updateResult(places, this.text);
            this._popover.showResult();
        }).bind(this));
    }
});
