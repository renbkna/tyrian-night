import QtQuick 2.15
import QtQuick.Controls 2.15

ApplicationWindow {
    id: window
    width: 720
    height: 520
    visible: true
    title: "Tyrian Union Smoke"

    Column {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 10

        Row {
            spacing: 8

            Button { text: "Button" }
            ToolButton { text: "Tool" }
            TabButton { text: "Tab"; checked: true }
        }

        TextField {
            width: 260
            placeholderText: "Text field"
            text: "Tyrian"
        }

        Row {
            spacing: 12

            CheckBox { text: "Check"; checked: true }
            RadioButton { text: "Radio"; checked: true }
            Switch { text: "Switch"; checked: true }
        }

        ItemDelegate {
            width: 320
            text: "Item delegate"
            highlighted: true
        }

        CheckDelegate {
            width: 320
            text: "Check delegate"
            checked: true
        }

        MenuItem {
            text: "Menu item"
            checkable: true
            checked: true
        }

        ProgressBar {
            width: 320
            value: 0.62
        }

        Slider {
            width: 320
            value: 0.45
        }

        ScrollBar {
            orientation: Qt.Horizontal
            width: 320
            size: 0.4
            position: 0.25
        }
    }

    Timer {
        interval: 250
        running: true
        repeat: false
        onTriggered: Qt.quit()
    }
}
