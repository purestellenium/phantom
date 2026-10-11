---
title: how to make a game in gamemaker!
description: how to make a basic top-down rpg game in gamemaker!
---

In this guide, we will be making a top-down game using Gamemaker called the Legend of Heidi! We are going to use Gamemaker which is a popular, beginner-friendly 2D game engine! Assets for the tutorials are from Rishabh's [Overdrive Tutorial](https://overdrive.campfire.hackclub.com/top-down)

## Setup Gamemaker

[Gamemaker](https://gamemaker.io/en) is a beginner friendly indie game engine aiding in making games much more faster. 

Go to [Gamemaker](https://gamemaker.io/en/download) to download and install it. The installation is really straightforward and common issues are already tackled by Gamemaker themselves.


Open Gamemaker and create a Blank Project.

Click on **New > Game > Blank Pixel Game** and change the **Project Name**
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/make-project.png)

Here is an overview on all the different things you can see when you open a new project.

![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/welcome-tab.png)
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/editor.png)

## Building the Base of Your Game

### 1. Sprites

Sprites are the images of your game. They represent your enemies, backgrounds and your player ( heidi )

To make a Sprite, right click on the blank space in the **Asset Browser** and click **Create Group**
and call it **Sprite**.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/create-group.png)

Then **Right-Click** on that folder and click **Create > Sprite** and call it **sPlayer**.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/create-sprite.png)

Now, you can import your Sprite! Making your own sprite is recommended, but you can also use this [Asset Pack](https://drive.google.com/file/d/1KkpG0I7GCsrUS6qMbJWTw0K3L5zbrgMA/view). Just hit **Import** and select the player sprite from the 
asset pack ( or your own assets )!
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/sprites-import.png)

Make sure to click **Yes** to the Popup!
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/yes.png)

You can notice that each of these sprites are 16x16 pixels or 32x32 pixels, because pixel art is done on a square grid which makes everything look neat and super easy to work with!

***Make sure to hit CTRL + S or CMD + S to save your project!***

### 2. Objects

Lets make some objects now! Since Sprites are the images for your game, they cannot function by themselves. You need to attach them to objects to make them do their intended task!

Create a new folder for **Objects**, and **Right-Click** on the folder and select **Create > Object** and call it **oPlayer** and assign the **sPlayer** sprite to it.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/objects.png)

Finally, go back and do it again for the player, slime and tree. Create sprites and their objects for each one. Make sure to import the Sprites and attach them to the objects! It should look like the following when everything is done correctly!
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/all-objects.png)

***Tip: Double Click on an Object/Sprite in the asset browser to open it***

### 3. Rooms

It's time to add your very first level! Start off by double clicking **Room1** to open it. Switch the background color to a grass-like colour. In the **Inspector**, click on the **Background** layer and switch the **Colour** there.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/background.png)

The default room size is really big, so let us change it to 320x180 for this example in the **Inspector** tab.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/room-size.png)

To make sure the game scales correctly, in the **Inspector**, scroll down and open **Viewports and Camera**, then toggle **Enable Viewports** and make **Viewport 0** Visible. Change the **Camera Properties** of **Viewport 0** to 320x180. (Not the **Viewport Properties**)
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/camera.png)

Also change the grid size in the top right corner of the room editor to 16x16 so that the objects snap to the grid.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/grids.png)

Now is the time to make your level! Switch back to the **Instances** layer and add objects. Drag in the objects from the **Asset Browser** into the Room, or after selecting an object, you can hold **ALT+Click** and **Click > Drag** to paint an object into the room. This is an example!
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/level.png)

### 4. Testing

Switch to an **HTML5** Build(Web Build) in the Top-Right corner. It will prompt you to *sign-in* and *download* the HTML5 Module. Switch to HTML5 again after signing in.
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/html.png)

Hit Play and hope that your game works!
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/play.png)


### 5. Events

Events can add code to your objects! First open the **oPlayer** object ( Double-Click on it in the asset browser), click **Add Event**, and create a **Create** Event and a **Step** event.

***Click GML Code if prompted***
![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/events.png)

#### Create Event
Next, add the following code to the **Create** event:

```java
    movement_speed = 1
```

This creates a variable which sets Heidi's movement speed.

The **Create** event only runs when an Object is created, so *x* and *y* speeds start off at **0** since Heidi is initially still. The **movement_speed** refers to the overall speed Heidi can move when the player presses the Arrow Keys.

***TIP: Don't forget to save your game often***

#### Step Event

The Step event runs every step (60/second), so any code here will be constantly running!

Let us first check for keyboard input, add this code to the **Step** event.

```java
x_speed = 0 
y_speed = 0 

if (keyboard_check(ord("D"))) { // if the d key is pressed 
    x_speed = movement_speed // add the movement speed to the x_speed variable 
} 

if (keyboard_check(ord("A"))) { 
    x_speed = -movement_speed 
} 

if (keyboard_check(ord("W"))) { 
    y_speed = -movement_speed 
} 

if (keyboard_check(ord("S"))) { 
    y_speed = movement_speed 
}
```

This creates a variable for movement in the *x* and *y* axes and uses keypresses to add our **movement_speed** to these variables.

***Gamemaker works a lot like a coordinate plane, with +x values being towards the right and -x values being towards the left. However, the vertical direction is flipped, with +y going downwards and -y going upwards.***

Now we can do our movement:

```java
x += x_speed 
y += y_speed
```

+= means that we are adding something to a value, so in this case we are adding our movement to the original Player position.

This happens multiple times a second making it look smooth. Click Play and try it out!

### 6. Fixing Movement

Now that our Heidi can move, you might find that it still feels a little weird to control.

You can change the movement speed in the **Create** event to something of your comfort if you prefer!

Let us make Heidi face the direction she moves. Add this to your code!

```java
if(x_speed < 0) { // if heidi is moving to the left
    image_xscale = 1 // make the sprite normal, what heidi already looks like
} else if (x_speed > 0) { // but if shes moving to the right
    image_xscale = -1 // flip heidi's sprite
}
```

If you try this, you'll notice Heidi teleports everytime she flips, this is because she flips around the **origin** of her sprite, which isn't the center.

Open Heidi's Sprite and change the Origin from **Top Left** to **Middle Centre**

![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/origin.png)

Now it should be working as intended!

### 7. Solids

Now when you playtest, you may have noticed that Heidi fell straight through the floor, so let us fix that!

First create a new object called **oSolid**. This will function as a parent object for all of our solid objects that Heidi can collide with.

Then, go to **Parent** and add **oTree** as a child object.

![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/parent.png)

This will serve as a parent object for all our Solid Objects, meaning we could add all sorts of things to its children like rocks and buildings. If we check that Heidi collides with **oSolid**, it will include collisions with all of its children.

Go to your **Step** event and replace this:
```java
x += x_speed 
y += y_speed
```
with this:
```java
move_and_collide(x_speed, y_speed, oSolid)
```

Now try it out!

### 8. Enemies
Now it is time to make the slimes move towards Heidi. I think you can try this out by yourself this time. Go ahead and make a **Create** and **Step** in **oSlime** and create a variable for movement speed in the create event ( Same thing you did for oPlayer ).

***You cannot just call the variable "speed" is a different variable that is built into gamemaker. If you try it, you'll see that the variable name turns green, and if that ever happens, you should choose a different variable name.***

Next the function we use for enemy behaviour is really simple!
```java
mp_potential_step(oPlayer.x, oPlayer.y, (your movement speed variable), true)
```

This is a super cool gamemaker function that can automatically pick a path for you enemies to move in. You just need the X and Y locations that it should try to move towards and the movement speed.

Don't worry about the last parameter for now, always put **true** there.

Now the enemies will follow you!
## Next Steps

So now what will happen when the player reaches the Flag?

A win screen? Another level? or a Super Epic Cutscene?

There are so many possibilities and this guide was meant as a short introduction to gamemaker.

![Assets](https://overdrive.campfire.hackclub.com/top-down/assets/game.gif)
## Publish on Itch.io

Go to [itch.io](https://itch.io) and create an account. And then head over to your [Dashboard](https://itch.io/dashboard).

Click on **Create new project** and customize your page! 

Once you're done, go back to GameMaker and click **Build** in the top left corner, and click **Create Executable > Package as Zip** and save the zip file anywhere you'd like.

Then on itch.io, click **Upload Files** and upload the zip folder you just created. Next, change the **Kind of Project** on itch.io to **HTML** and under the folder you uploaded, check **This file will be played in the browser**.

Change the **Viewport Dimensions** to the **Viewport Properties** of your viewport (bottom left corner of the room editor).

You can now click **Save and View Page** to see your game's website.

Once you have everything ready, click **Draft** at the top and change **Visibility and Access** to **Public** and save.

Now you can share the game link to anyone!

---

*This guide was originally written by Rishabh Agarwal for [Campfire Overdrive](https://overdrive.campfire.hackclub.com/). Transcribed by JakeOJeff*
